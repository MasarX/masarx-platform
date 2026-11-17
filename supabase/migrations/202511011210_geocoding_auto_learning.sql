-- Migration: Geocoding auto-learning
-- Purpose: Promote high-confidence provider results into canonical geography tables or queue manual review.
-- Alignment: DYNAMIC - ZERO HARD CODING - behaviour controlled by geocoding_policy settings.

BEGIN;

CREATE OR REPLACE FUNCTION public.auto_learn_geography(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_address_id UUID,
    p_geocode JSONB,
    p_policy JSONB,
    p_confidence NUMERIC,
    p_action TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_policy JSONB;
    v_auto JSONB;
    v_manual JSONB;
    v_threshold NUMERIC;
    v_enabled BOOLEAN;
    v_city_action TEXT;
    v_district_action TEXT;
    v_city_name TEXT;
    v_district_name TEXT;
    v_country_code TEXT;
    v_city_id UUID;
    v_result JSONB := jsonb_build_object(
        'processed', FALSE,
        'city_learned', FALSE,
        'district_learned', FALSE,
        'manual_review_enqueued', FALSE
    );
    v_sla_minutes INT;
    v_provider_payload JSONB := COALESCE(p_policy, '{}'::jsonb);
    v_address_json JSONB := COALESCE(p_geocode, '{}'::jsonb);
    v_provider_name TEXT := p_action;
BEGIN
    -- Resolve policy ladder: sender -> client -> tenant -> global
    v_policy := resolve_settings('geocoding_policy', 'sender', p_sender_id);
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'client', p_client_id);
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'tenant', p_organization_id);
    END IF;
    IF v_policy IS NULL THEN
        v_policy := resolve_settings('geocoding_policy', 'global', NULL);
    END IF;

    IF v_policy IS NULL THEN
        RETURN v_result;
    END IF;

    v_auto := COALESCE(v_policy->'auto_learning', '{}'::jsonb);
    v_enabled := COALESCE((v_auto->>'enabled')::BOOLEAN, FALSE);
    IF NOT v_enabled THEN
        RETURN v_result;
    END IF;

    v_threshold := COALESCE((v_auto->>'confidence_threshold_for_auto_learn')::NUMERIC, 0.9);
    IF p_confidence IS NULL OR p_confidence < v_threshold THEN
        RETURN v_result || jsonb_build_object('processed', TRUE, 'reason', 'confidence_below_threshold');
    END IF;

    v_city_action := COALESCE(v_auto->'components'->'city'->>'action_lookup', 'add_immediately');
    v_district_action := COALESCE(v_auto->'components'->'district'->>'action_lookup', 'queue_for_review');

    -- Parse city/district from provider payload
    IF v_provider_payload ? 'address_components' AND jsonb_typeof(v_provider_payload->'address_components') = 'object' THEN
        v_city_name := COALESCE(
            NULLIF(v_provider_payload->'address_components'->>'city', ''),
            NULLIF(v_provider_payload->'address_components'->>'municipality', ''),
            NULLIF(v_provider_payload->'address_components'->>'county', ''),
            NULLIF(v_provider_payload->'address_components'->>'state', '')
        );
        v_district_name := COALESCE(
            NULLIF(v_provider_payload->'address_components'->>'district', ''),
            NULLIF(v_provider_payload->'address_components'->>'county', '')
        );
        v_country_code := NULLIF(v_provider_payload->'address_components'->>'countryCode', '');
    ELSIF v_provider_payload ? 'address_components' AND jsonb_typeof(v_provider_payload->'address_components') = 'array' THEN
        FOR v_city_name IN
            SELECT elem->>'long_name'
            FROM jsonb_array_elements(v_provider_payload->'address_components') elem
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb))
                WHERE value IN ('locality', 'postal_town', 'administrative_area_level_2')
            )
            LIMIT 1
        LOOP
            EXIT;
        END LOOP;

        FOR v_district_name IN
            SELECT elem->>'long_name'
            FROM jsonb_array_elements(v_provider_payload->'address_components') elem
            WHERE EXISTS (
                SELECT 1
                FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb))
                WHERE value IN ('sublocality', 'administrative_area_level_3', 'administrative_area_level_2')
            )
            LIMIT 1
        LOOP
            EXIT;
        END LOOP;

        SELECT elem->>'short_name'
        INTO v_country_code
        FROM jsonb_array_elements(v_provider_payload->'address_components') elem
        WHERE EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(COALESCE(elem->'types', '[]'::jsonb)) WHERE value = 'country'
        )
        LIMIT 1;
    END IF;

    IF v_city_name IS NULL OR v_city_name = '' THEN
        v_city_name := COALESCE(NULLIF(v_address_json->>'city', ''), NULLIF(v_address_json->>'province', ''));
    END IF;

    IF v_district_name IS NULL OR v_district_name = '' THEN
        v_district_name := NULLIF(v_address_json->>'district', '');
    END IF;

    v_country_code := COALESCE(NULLIF(v_address_json->>'country', ''), v_country_code, 'SA');

    -- Insert/Update city
    IF v_city_name IS NOT NULL AND POSITION('add_immediately' IN v_city_action) > 0 THEN
        INSERT INTO canonical_cities (
            organization_id,
            name_canonical,
            country_code,
            source,
            metadata
        )
        VALUES (
            p_organization_id,
            v_city_name,
            v_country_code,
            'auto_learn',
            jsonb_build_object(
                'confidence', p_confidence,
                'provider', v_provider_name,
                'learned_at', now()
            )
        )
        ON CONFLICT (organization_id, name_canonical) WHERE source_city_id IS NULL DO UPDATE
        SET metadata = canonical_cities.metadata || jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        ),
            updated_at = now()
        RETURNING canonical_cities.id INTO v_city_id;

        v_result := v_result || jsonb_build_object('city_learned', TRUE);
    ELSE
        SELECT id INTO v_city_id
        FROM canonical_cities
        WHERE organization_id = p_organization_id
          AND name_canonical = v_city_name;
    END IF;

    IF v_city_id IS NULL THEN
        SELECT id INTO v_city_id
        FROM canonical_cities
        WHERE organization_id = p_organization_id
        ORDER BY (name_canonical = v_city_name) DESC, created_at DESC
        LIMIT 1;
    END IF;

    -- District handling
    IF v_city_id IS NOT NULL
       AND v_district_name IS NOT NULL
       AND v_district_name <> ''
       AND POSITION('add_immediately' IN v_district_action) > 0 THEN
        INSERT INTO canonical_districts (
            organization_id,
            city_id,
            name_canonical,
            source,
            metadata
        )
        VALUES (
            p_organization_id,
            v_city_id,
            v_district_name,
            'auto_learn',
            jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        )
        )
        ON CONFLICT (organization_id, city_id, name_canonical) WHERE source_district_id IS NULL DO UPDATE
        SET metadata = canonical_districts.metadata || jsonb_build_object(
            'confidence', p_confidence,
            'provider', v_provider_name,
            'learned_at', now()
        ),
            updated_at = now();

        v_result := v_result || jsonb_build_object('district_learned', TRUE);
    ELSIF v_district_name IS NOT NULL
       AND POSITION('queue_for_review' IN v_district_action) > 0 THEN
        v_manual := COALESCE(v_policy->'manual_review', '{}'::jsonb);
        v_sla_minutes := COALESCE((v_manual->>'sla_minutes')::INT, 60);

        IF NOT EXISTS (
            SELECT 1
            FROM manual_review_tasks
            WHERE task_type = 'geocoding_auto_learn'
              AND status = 'pending'
              AND address_id = p_address_id
              AND queue_assignment = 'geo_ops_review'
        ) THEN
            INSERT INTO manual_review_tasks (
                organization_id,
                client_id,
                sender_id,
                address_id,
                task_type,
                reason,
                status,
                queue_assignment,
                sla_minutes,
                sla_due_at,
                metadata
            )
            VALUES (
                p_organization_id,
                p_client_id,
                p_sender_id,
                p_address_id,
                'geocoding_auto_learn',
                'Auto-learn district requires approval',
                'pending',
                'geo_ops_review',
                v_sla_minutes,
                now() + make_interval(mins => v_sla_minutes),
                jsonb_build_object(
                    'district_name', v_district_name,
                    'city_name', v_city_name,
                    'confidence', p_confidence,
                    'provider', v_provider_name
                )
            );
        END IF;

        v_result := v_result || jsonb_build_object('manual_review_enqueued', TRUE);
    END IF;

    RETURN v_result || jsonb_build_object('processed', TRUE);
END;
$$;

COMMENT ON FUNCTION public.auto_learn_geography(UUID, UUID, UUID, UUID, JSONB, JSONB, NUMERIC, TEXT)
    IS 'Auto-learn canonical geography entries based on policy thresholds; queues manual review when configured.';

COMMIT;
