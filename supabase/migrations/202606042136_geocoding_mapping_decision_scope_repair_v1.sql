-- Repair geocoding mapping aliases, Arabic canonical city aliases, and
-- step-scoped geocoding decision provenance.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042136_geocoding_mapping_decision_scope_repair_v1'));

UPDATE public.canonical_cities
   SET name_arabic = COALESCE(NULLIF(name_arabic, ''), 'الرياض'),
       alternate_names = CASE
         WHEN COALESCE(alternate_names, ARRAY[]::text[]) @> ARRAY['الرياض']::text[]
           THEN alternate_names
         ELSE COALESCE(alternate_names, ARRAY[]::text[]) || ARRAY['الرياض']::text[]
       END,
       updated_at = now()
 WHERE lower(name_canonical) = 'riyadh'
   AND country_code = 'SA'
   AND (
     NULLIF(name_arabic, '') IS NULL
     OR NOT (COALESCE(alternate_names, ARRAY[]::text[]) @> ARRAY['الرياض']::text[])
   );

CREATE OR REPLACE FUNCTION public.apply_mapping_config(
    p_source JSONB,
    p_mapping_config_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_config RECORD;
    v_result JSONB := '{}'::JSONB;
    v_target TEXT;
    v_spec JSONB;
    v_field_key TEXT;
    v_field_spec JSONB;
    v_path TEXT;
    v_field_val JSONB;
    v_object JSONB;
    v_candidate_paths TEXT[];
BEGIN
    IF p_source IS NULL OR p_mapping_config_id IS NULL THEN
        RETURN p_source;
    END IF;

    SELECT mapping_config
      INTO v_config
      FROM public.mapping_configs
     WHERE id = p_mapping_config_id;

    IF NOT FOUND OR v_config.mapping_config IS NULL THEN
        RETURN p_source;
    END IF;

    IF v_config.mapping_config ? 'field_mappings' THEN
        v_result := public.jsonb_extract_fields(
            p_source,
            v_config.mapping_config->'field_mappings'
        );
        RETURN v_result;
    END IF;

    IF v_config.mapping_config ? 'transforms' THEN
        v_result := '{}'::jsonb;
        FOR v_target, v_spec IN
            SELECT key, value
              FROM jsonb_each(v_config.mapping_config->'transforms')
        LOOP
            IF jsonb_typeof(v_spec) = 'object' THEN
                v_object := '{}'::jsonb;
                FOR v_field_key, v_field_spec IN
                    SELECT key, value
                      FROM jsonb_each(v_spec)
                LOOP
                    SELECT COALESCE(array_agg(elem), ARRAY[]::text[])
                      INTO v_candidate_paths
                      FROM jsonb_array_elements_text(
                        CASE
                          WHEN jsonb_typeof(v_field_spec) = 'string'
                            THEN jsonb_build_array(v_field_spec)
                          WHEN jsonb_typeof(v_field_spec) = 'array'
                            THEN v_field_spec
                          ELSE '[]'::jsonb
                        END
                      ) AS elem;

                    v_field_val := NULL;
                    FOREACH v_path IN ARRAY v_candidate_paths LOOP
                        v_path := NULLIF(btrim(v_path), '');
                        IF v_path IS NULL THEN
                            CONTINUE;
                        END IF;

                        BEGIN
                            IF v_path LIKE '$%' THEN
                                v_field_val := public.safe_jsonpath_query_first(p_source, v_path);
                            ELSE
                                v_field_val := public.jsonb_resolve_path(p_source, v_path);
                            END IF;
                        EXCEPTION
                            WHEN OTHERS THEN
                                v_field_val := NULL;
                        END;

                        IF v_field_val IS NULL OR v_field_val = 'null'::jsonb THEN
                            v_field_val := NULL;
                        ELSE
                            EXIT;
                        END IF;
                    END LOOP;

                    IF v_field_val IS NULL THEN
                        v_field_val := 'null'::jsonb;
                    END IF;

                    v_object := jsonb_set(v_object, ARRAY[v_field_key], v_field_val, TRUE);
                END LOOP;
                v_result := jsonb_set(v_result, ARRAY[v_target], v_object, TRUE);
            END IF;
        END LOOP;
        RETURN v_result;
    END IF;

    RETURN p_source;
END;
$function$;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_address_intake_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
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
    v_raw_payload JSONB := '{}'::jsonb;
    v_transformed_payload JSONB := '{}'::jsonb;
    v_mapping JSONB;
    v_address_map JSONB;
    v_line1 TEXT;
    v_line2 TEXT;
    v_city TEXT;
    v_city_raw TEXT;
    v_district TEXT;
    v_province TEXT;
    v_province_raw TEXT;
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

    v_raw_payload := COALESCE(v_webhook.raw_payload, '{}'::jsonb);
    v_transformed_payload := COALESCE(v_webhook.transformed_payload, '{}'::jsonb);
    v_payload := CASE
      WHEN v_raw_payload <> '{}'::jsonb THEN v_raw_payload
      ELSE v_transformed_payload
    END;

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

    v_line1 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line1'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line1')
    );
    v_line2 := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'line2'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'line2')
    );
    v_city := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'city'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'city')
    );
    v_district := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'district'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'district')
    );
    v_province := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'province'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'province')
    );
    v_country := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'country'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'country')
    );
    v_postal := COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'postal_code'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'postal_code')
    );
    v_lat := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lat'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lat')
    ), '')::NUMERIC;
    v_lng := NULLIF(COALESCE(
      workflow_handlers.resolve_path_text(v_payload, v_address_map->>'lng'),
      workflow_handlers.resolve_path_text(v_transformed_payload, v_address_map->>'lng')
    ), '')::NUMERIC;

    v_country := COALESCE(NULLIF(v_country, ''), 'SA');

    v_city_raw := NULLIF(v_city, '');
    v_province_raw := NULLIF(v_province, '');
    v_city := COALESCE(v_city_raw, '');
    v_province := COALESCE(v_province_raw, '');

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
        'city', v_city_raw,
        'province', v_province_raw,
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

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS void
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_run workflow_runs%ROWTYPE;
  v_ctx RECORD;
  v_policy_record RECORD;
  v_settings_id UUID := NULL;
  v_settings_version_id UUID := NULL;
  v_version INT := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_inputs JSONB := NULL;
  v_settings_resolution_id UUID := NULL;
BEGIN
  IF NOT v_can_log THEN
    RETURN;
  END IF;

  SELECT * INTO v_run FROM public.workflow_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_ctx FROM public.geocoding_extract_policy_context_v1(v_run);
  IF v_ctx.organization_id IS NULL THEN
    RETURN;
  END IF;

  v_scope_path := '[]'::jsonb;
  IF v_ctx.webhook_source_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('source'::text);
  END IF;
  IF v_ctx.sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('sender'::text);
  END IF;
  IF v_ctx.client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('client'::text);
  END IF;
  v_scope_path := v_scope_path || to_jsonb('tenant'::text);
  v_scope_path := v_scope_path || to_jsonb('global'::text);

  SELECT *
  INTO v_policy_record
  FROM public.geocoding_resolve_policy(
    v_ctx.organization_id,
    v_ctx.client_id,
    v_ctx.sender_id,
    v_ctx.webhook_source_id
  )
  LIMIT 1;

  IF v_policy_record.scope_type IS NULL THEN
    v_policy_record.scope_type := 'global';
    v_policy_record.scope_id := NULL;
  END IF;

  IF v_policy_record.scope_type IS NOT NULL THEN
    SELECT
      s.id AS settings_id,
      s.settings_version_id AS settings_version_id,
      sv.version AS version
    INTO v_settings_id, v_settings_version_id, v_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'geocoding_policy'
      AND s.scope_type = v_policy_record.scope_type
      AND s.scope_id IS NOT DISTINCT FROM v_policy_record.scope_id
    ORDER BY s.last_updated DESC
    LIMIT 1;
  END IF;

  IF v_settings_id IS NOT NULL THEN
    v_inputs := jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', p_run_id,
      'workflow_step_id', p_step_id,
      'organization_id', v_ctx.organization_id,
      'client_id', v_ctx.client_id,
      'sender_id', v_ctx.sender_id,
      'webhook_source_id', v_ctx.webhook_source_id,
      'decision_point', COALESCE(p_match->>'plugin', 'geocoding'),
      'decision_outcome', COALESCE(p_match->>'match_type', 'unknown')
    ));

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'geocoding_policy',
      p_winning_scope_type := v_policy_record.scope_type,
      p_winning_scope_id := v_policy_record.scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := COALESCE(v_version, 1),
      p_scope_path := v_scope_path,
      p_inputs := v_inputs,
      p_merge_notes := NULL
    );
  END IF;

  INSERT INTO public.decision_log (
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    settings_resolution_id
  )
  VALUES (
    v_ctx.organization_id,
    'geocoding',
    'workflow_run_step',
    p_step_id,
    COALESCE(p_match->>'plugin', 'geocoding'),
    COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', p_run_id,
      'address_id', v_ctx.address_id,
      'shipment_id', v_ctx.shipment_id,
      'client_id', v_ctx.client_id,
      'sender_id', v_ctx.sender_id,
      'webhook_source_id', v_ctx.webhook_source_id,
      'match', p_match
    )),
    'Geocoding match scored through row-driven geocoding_policy.',
    'workflow_handlers.geocoding_log_match',
    p_run_id,
    v_settings_resolution_id
  );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202606042136_geocoding_mapping_decision_scope_repair_v1'));

COMMIT;
