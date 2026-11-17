-- Migration: Webhook geocoding intake handler + mapping/policy seed
-- Purpose:
--   1) Add address_intake workflow handler to materialize addresses from webhook payloads and
--      expose provided coordinates for geocoding workflows.
--   2) Insert the handler into workflow_geocoding_standard so webhook-triggered runs can
--      create addresses before local/provider geocoding.
--   3) Seed a reusable webhook source, inbound mapping, and ingest policy for geocoding intake
--      tests (EXAMPLE_PASSWORD / geocoding-intake-test).

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- Helper: resolve a pipe-delimited list of JSON paths against a payload and return scalar text.
CREATE OR REPLACE FUNCTION workflow_handlers.resolve_path_text(
    p_payload JSONB,
    p_paths TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
AS $$
DECLARE
    v_token TEXT;
    v_candidate JSONB;
BEGIN
    IF p_payload IS NULL OR p_paths IS NULL OR btrim(p_paths) = '' THEN
        RETURN NULL;
    END IF;

    FOREACH v_token IN ARRAY string_to_array(p_paths, '|') LOOP
        v_token := btrim(v_token);
        IF v_token = '' THEN
            CONTINUE;
        END IF;

        v_candidate := jsonb_resolve_path(p_payload, v_token);

        IF v_candidate IS NOT NULL AND v_candidate::TEXT <> 'null' THEN
            IF jsonb_typeof(v_candidate) IN ('string', 'number', 'boolean') THEN
                RETURN v_candidate #>> '{}';
            ELSE
                RETURN v_candidate::TEXT;
            END IF;
        END IF;
    END LOOP;

    RETURN NULL;
END;
$$;

COMMENT ON FUNCTION workflow_handlers.resolve_path_text(JSONB, TEXT)
    IS 'Resolve first non-null value from pipe-delimited JSON paths against a payload and return scalar text.';

-- Handler: create/normalize address input from webhook payload and expose provided coordinates.
CREATE OR REPLACE FUNCTION workflow_handlers.execute_address_intake_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
    v_step_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_response public.workflow_handler_response;
    v_webhook_id UUID := NULLIF(v_ctx->>'webhook_id', '')::UUID;
    v_address_id UUID := NULLIF(v_ctx->>'address_id', '')::UUID;
    v_mapping_id UUID := COALESCE(
        NULLIF(v_step_metadata->>'mapping_config_id', '')::UUID,
        NULLIF(v_ctx->>'mapping_config_id', '')::UUID
    );
    v_webhook RECORD;
    v_source RECORD;
    v_payload JSONB := '{}'::jsonb;
    v_mapping JSONB;
    v_address_map JSONB;
    v_line1 TEXT;
    v_line2 TEXT;
    v_city TEXT;
    v_district TEXT;
    v_province TEXT;
    v_country TEXT;
    v_postal TEXT;
    v_lat NUMERIC;
    v_lng NUMERIC;
    v_raw JSONB;
    v_inserted_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_provided_coords JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);

    IF v_address_id IS NOT NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'address_present');
        RETURN v_response;
    END IF;

    IF v_webhook_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_missing');
        RETURN v_response;
    END IF;

    SELECT
        wi.raw_payload,
        wi.transformed_payload,
        wi.webhook_source_id
    INTO v_webhook
    FROM public.webhook_inbox wi
    WHERE wi.id = v_webhook_id;

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'webhook_not_found');
        RETURN v_response;
    END IF;

    v_payload := COALESCE(v_webhook.transformed_payload, v_webhook.raw_payload, '{}'::jsonb);

    SELECT
        ws.organization_id,
        ws.sender_id,
        ws.mapping_config_id,
        s.client_id
    INTO v_source
    FROM public.webhook_sources ws
    LEFT JOIN public.senders s ON s.id = ws.sender_id
    WHERE ws.id = v_webhook.webhook_source_id;

    v_org := COALESCE(
        v_source.organization_id,
        NULLIF(v_ctx->>'organization_id', '')::UUID
    );
    v_client := COALESCE(
        v_source.client_id,
        NULLIF(v_ctx->>'client_id', '')::UUID
    );
    v_sender := COALESCE(
        v_source.sender_id,
        NULLIF(v_ctx->>'sender_id', '')::UUID
    );

    IF v_mapping_id IS NULL THEN
        v_mapping_id := v_source.mapping_config_id;
    END IF;

    IF v_mapping_id IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('created', FALSE, 'reason', 'mapping_missing');
        RETURN v_response;
    END IF;

    SELECT mapping_config
      INTO v_mapping
      FROM public.mapping_configs
     WHERE id = v_mapping_id
       AND mapping_type = 'webhook_inbound';

    IF NOT FOUND THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'mapping_not_found',
            'mapping_config_id', v_mapping_id
        );
        RETURN v_response;
    END IF;

    v_address_map := COALESCE(v_mapping->'transforms'->'address', '{}'::jsonb);

    v_line1 := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line1');
    v_line2 := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line2');
    v_city := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'city');
    v_district := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'district');
    v_province := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'province');
    v_country := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'country');
    v_postal := workflow_handlers.resolve_path_text(v_payload, v_address_map->>'postal_code');
    v_lat := (workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lat'))::NUMERIC;
    v_lng := (workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lng'))::NUMERIC;

    v_country := COALESCE(NULLIF(v_country, ''), 'SA');
    v_city := COALESCE(NULLIF(v_city, ''), 'unknown');
    v_province := COALESCE(NULLIF(v_province, ''), 'unknown');
    v_line1 := NULLIF(v_line1, '');
    v_line2 := NULLIF(v_line2, '');
    v_district := NULLIF(v_district, '');
    v_postal := NULLIF(v_postal, '');

    IF v_org IS NULL OR v_client IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'created', FALSE,
            'reason', 'scope_missing',
            'organization_id', v_org,
            'client_id', v_client
        );
        RETURN v_response;
    END IF;

    v_raw := jsonb_strip_nulls(jsonb_build_object(
        'line1', v_line1,
        'line2', v_line2,
        'district', v_district,
        'city', v_city,
        'province', v_province,
        'country', v_country,
        'postal_code', v_postal,
        'lat', v_lat,
        'lng', v_lng
    ));

    IF v_lat IS NOT NULL AND v_lng IS NOT NULL
       AND v_lat BETWEEN -90 AND 90
       AND v_lng BETWEEN -180 AND 180 THEN
        v_provided_coords := jsonb_build_object(
            'latitude', v_lat,
            'longitude', v_lng
        );
    END IF;

    INSERT INTO public.addresses (
        id,
        organization_id,
        client_id,
        raw_input,
        normalized_line1,
        normalized_line2,
        district,
        city,
        province,
        postal_code,
        country,
        line1,
        line2,
        validation_status,
        created_at,
        updated_at
    )
    VALUES (
        gen_random_uuid(),
        v_org,
        v_client,
        COALESCE(v_raw, '{}'::jsonb)::TEXT,
        v_line1,
        v_line2,
        v_district,
        v_city,
        v_province,
        v_postal,
        v_country,
        v_line1,
        v_line2,
        'pending',
        now(),
        now()
    )
    RETURNING id INTO v_inserted_id;

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'created', TRUE,
        'address_id', v_inserted_id,
        'mapping_config_id', v_mapping_id,
        'source_id', v_webhook.webhook_source_id
    ));
    v_response.context_patch := jsonb_strip_nulls(jsonb_build_object(
        'address_id', v_inserted_id,
        'organization_id', v_org,
        'client_id', v_client,
        'sender_id', v_sender,
        'address_input', v_raw,
        'geocoding', jsonb_build_object(
            'provided_coordinates', v_provided_coords
        )
    ));

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_address_intake_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Creates address records from webhook payloads and surfaces provided coordinates for geocoding workflows.';

INSERT INTO operation_handlers AS oh (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    notes,
    doc_url
)
VALUES (
    'address_intake',
    'workflow_handlers',
    'execute_address_intake_v1',
    '(public.workflow_run_steps,public.workflow_runs,jsonb)',
    'v1',
    TRUE,
    'Create/normalize address input from webhook payloads and expose provided coordinates.',
    NULL
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

-- Insert address_intake as the first step of workflow_geocoding_standard.
DO $$
DECLARE
    v_template_id UUID;
    v_step_id UUID := '99990000-0000-0000-0000-000000410000'::UUID;
BEGIN
    SELECT id INTO v_template_id
    FROM public.workflow_templates
    WHERE name = 'workflow_geocoding_standard'
    LIMIT 1;

    IF v_template_id IS NULL THEN
        RAISE NOTICE 'workflow_geocoding_standard not found; skipping address_intake insertion';
        RETURN;
    END IF;

    UPDATE public.workflow_template_steps
    SET sequence_order = sequence_order + 1
    WHERE workflow_template_id = v_template_id;

    INSERT INTO public.workflow_template_steps (
        id,
        workflow_template_id,
        sequence_order,
        operation_name,
        operation_settings_category,
        transition_condition,
        handler_key,
        handler_version,
        metadata,
        manual_action_required,
        enabled
    )
    VALUES (
        v_step_id,
        v_template_id,
        1,
        'address_intake',
        'geocoding',
        'always',
        'address_intake',
        'v1',
        jsonb_build_object('decision_log_event', 'geocoding.address_intake'),
        FALSE,
        TRUE
    )
    ON CONFLICT (id) DO UPDATE
    SET sequence_order = EXCLUDED.sequence_order,
        metadata = EXCLUDED.metadata,
        updated_at = now();

    WITH ordered_steps AS (
        SELECT
            sequence_order,
            jsonb_build_object(
                'sequence_order', sequence_order,
                'operation_name', operation_name,
                'handler_key', handler_key,
                'handler_version', handler_version,
                'metadata', COALESCE(metadata, '{}'::jsonb)
            ) AS payload
        FROM public.workflow_template_steps
        WHERE workflow_template_id = v_template_id
        ORDER BY sequence_order
    ),
    hashed AS (
        SELECT md5(coalesce(jsonb_agg(payload ORDER BY sequence_order)::text, '')) AS checksum
        FROM ordered_steps
    )
    UPDATE public.workflow_templates wt
    SET steps_checksum = hashed.checksum,
        updated_at = now()
    FROM hashed
    WHERE wt.id = v_template_id;
END
$$;

-- Fixture source/mapping/policy seeds were intentionally removed from the active migration chain.
-- Test-only geocoding intake fixtures are provisioned via scripts/tests/bootstrap/*
-- with runtime production guards.

COMMIT;
