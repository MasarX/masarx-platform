-- Migration: Provider dispatch short-code hardening (use normalized helper; allow country-missing)
-- Purpose:
--   - Use public.geocoding_normalize_candidate_code() for short-code detection (safe regex handling, no duplication).
--   - Apply HERE short-code query hints even when address.country is missing (clients may send short code only).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow-driven - ZERO REDUNDANCY - ZERO HARD CODING.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
    v_ctx RECORD;
    v_policy_record RECORD;
    v_policy JSONB;
    v_reverse_enabled BOOLEAN := TRUE;
    v_provider_candidates TEXT[];
    v_sequence_index INT;
    v_candidate_index INT;
    v_provider RECORD;
    v_provider_name TEXT;
    v_template operation_templates%ROWTYPE;
    v_template_metadata JSONB;
    v_template_query JSONB;
    v_query_context JSONB;
    v_query_element JSONB;
    v_query_string TEXT := '';
    v_address RECORD;
    v_address_text TEXT;
    v_address_in TEXT;
    v_address_types TEXT;
    v_lang TEXT := COALESCE(NULLIF(v_metadata->>'lang', ''), 'en');
    v_limit INT := COALESCE((v_metadata->>'limit')::INT, 1);
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_step_record workflow_run_steps%ROWTYPE;
    v_backpressure JSONB;
    v_queue_depth INT := 0;
    v_max_queue_depth INT;
    v_throttle_depth INT;
    v_delay_seconds INT;
    v_resume_seconds INT;
    v_response workflow_handler_response;
    v_value JSONB;
    v_value_text TEXT;
    v_is_reverse BOOLEAN := COALESCE((v_metadata->>'reverse_geocode')::BOOLEAN, FALSE);
    v_short_plugin JSONB;
    v_short_params JSONB;
    v_short_enabled BOOLEAN := FALSE;
    v_short_country_gate TEXT;
    v_short_code_regex TEXT;
    v_short_candidate TEXT;
    v_short_code TEXT;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    -- Short-circuit: if geocoding is already resolved (local/cache/manual), do not dispatch providers.
    IF COALESCE(p_run.context->'geocoding'->>'successful', 'false')::BOOLEAN THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'skipped', TRUE,
            'reason', 'geocoding_already_resolved'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'dispatch_skipped', TRUE
            )
        );
        RETURN v_response;
    END IF;

    SELECT * INTO v_ctx FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
    END IF;

    SELECT *
    INTO v_policy_record
    FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )
    LIMIT 1;

    v_policy := v_policy_record.policy;

    IF v_policy IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: geocoding_policy missing for workflow_run %', p_step.workflow_run_id;
    END IF;

    -- Auto-reverse routing: when coordinates are present and reverse is enabled, dispatch reverse templates.
    v_reverse_enabled := COALESCE((workflow_handlers.geocoding_get_plugin(v_policy, 'reverse')->>'enabled')::BOOLEAN, TRUE);
    IF NOT v_is_reverse THEN
        IF COALESCE((p_run.context->'geocoding'->>'reverse_geocode')::BOOLEAN, FALSE) THEN
            v_is_reverse := TRUE;
        ELSIF v_reverse_enabled AND COALESCE(p_run.context->'geocoding'->'provided_coordinates', p_run.context->'shipment'->'coordinates') IS NOT NULL THEN
            v_is_reverse := TRUE;
        END IF;
    END IF;

    v_backpressure := COALESCE(v_policy->'backpressure', '{}'::jsonb);
    v_max_queue_depth := COALESCE((v_backpressure->>'max_queue_depth')::INT, NULL);
    v_throttle_depth := COALESCE((v_backpressure->>'throttle_ingest_at')::INT, NULL);
    v_delay_seconds := COALESCE((v_backpressure->>'throttle_delay_seconds')::INT, 30);
    v_resume_seconds := COALESCE((v_backpressure->>'resume_after_seconds')::INT, 120);

    IF v_max_queue_depth IS NOT NULL OR v_throttle_depth IS NOT NULL THEN
        SELECT COALESCE(COUNT(*), 0)
        INTO v_queue_depth
        FROM workflow_runs wr
        JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
        JOIN workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
        LEFT JOIN LATERAL geocoding_extract_context(wr) ctx ON TRUE
        WHERE wt.name LIKE 'workflow_geocoding%'
          AND wrs.operation_name IN ('dispatch_provider', 'fallback_provider')
          AND wrs.step_status IN ('pending', 'in_progress')
          AND wr.id <> p_run.id
          AND ctx.client_id IS NOT NULL
          AND ctx.client_id = v_ctx.client_id;

        IF v_max_queue_depth IS NOT NULL
           AND v_queue_depth >= v_max_queue_depth
           AND COALESCE((v_backpressure->>'pause_workflow_when_full')::BOOLEAN, FALSE) THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_resume_seconds, 30));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_max_queue',
                'queue_depth', v_queue_depth,
                'max_queue_depth', v_max_queue_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'paused',
                        'queue_depth', v_queue_depth,
                        'max_queue_depth', v_max_queue_depth
                    )
                )
            );
            RETURN v_response;
        END IF;

        IF v_throttle_depth IS NOT NULL AND v_queue_depth >= v_throttle_depth THEN
            v_response.status := 'pending';
            v_response.next_run_at := now() + make_interval(secs => GREATEST(v_delay_seconds, 10));
            v_response.operation_result := jsonb_build_object(
                'skipped', TRUE,
                'reason', 'backpressure_throttle',
                'queue_depth', v_queue_depth,
                'throttle_ingest_at', v_throttle_depth
            );
            v_response.context_patch := jsonb_build_object(
                'geocoding', jsonb_build_object(
                    'backpressure', jsonb_build_object(
                        'status', 'throttled',
                        'queue_depth', v_queue_depth,
                        'throttle_ingest_at', v_throttle_depth
                    )
                )
            );
            RETURN v_response;
        END IF;
    END IF;

    v_provider_candidates := ARRAY(
        SELECT elem::TEXT
        FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
        WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
    );

    IF array_length(v_provider_candidates, 1) IS NULL OR array_length(v_provider_candidates, 1) = 0 THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: provider_priority empty for workflow_run %', p_step.workflow_run_id;
    END IF;

    v_sequence_index := COALESCE(
        NULLIF(v_metadata->>'provider_sequence_index', '')::INT,
        0
    );

    v_candidate_index := v_sequence_index;
    WHILE v_candidate_index < COALESCE(array_length(v_provider_candidates, 1), 0) LOOP
        v_provider_name := v_provider_candidates[v_candidate_index + 1];

        SELECT pr.* INTO v_provider
        FROM public.providers pr
        WHERE pr.name = v_provider_name
        LIMIT 1;

        IF v_provider.id IS NULL THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        SELECT *
        INTO v_template
        FROM public.operation_templates ot
        WHERE ot.provider_id = v_provider.id
          AND (
                NULLIF(v_metadata->>'operation_name', '') IS NULL
                OR ot.operation_name = v_metadata->>'operation_name'
          )
          AND COALESCE(ot.metadata->>'operation_role', '') = CASE
              WHEN v_is_reverse THEN 'geocoding_reverse'
              ELSE 'geocoding_forward'
          END
        ORDER BY ot.updated_at DESC
        LIMIT 1;

        IF v_template.id IS NOT NULL THEN
            EXIT;
        END IF;

        v_candidate_index := v_candidate_index + 1;
    END LOOP;

    IF v_template.id IS NULL THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: operation template missing for provider % (reverse=%)', v_provider_name, v_is_reverse;
    END IF;

    SELECT
        a.sa_short_code,
        COALESCE(a.normalized_line1, a.line1, (a.raw_input::jsonb)->>'line1', '') AS line1,
        COALESCE(a.normalized_line2, a.line2, (a.raw_input::jsonb)->>'line2', '') AS line2,
        COALESCE(a.district, '') AS district,
        COALESCE(a.city, (a.raw_input::jsonb)->>'city', '') AS city,
        COALESCE(a.province, (a.raw_input::jsonb)->>'province', '') AS province,
        COALESCE(a.country, (a.raw_input::jsonb)->>'country', '') AS country
    INTO v_address
    FROM public.addresses a
    WHERE a.id = v_ctx.address_id;

    v_address_text := COALESCE(
        NULLIF(p_run.context->'geocoding'->>'normalized_address', ''),
        NULLIF(trim(concat_ws(
            ' ',
            NULLIF(v_address.line1, ''),
            NULLIF(v_address.line2, ''),
            NULLIF(v_address.district, ''),
            NULLIF(v_address.city, ''),
            NULLIF(v_address.province, ''),
            NULLIF(v_address.country, '')
        )), '')
    );

    -- Short-code aware dispatch hints (HERE: in/types) (only for forward queries).
    v_short_plugin := workflow_handlers.geocoding_get_plugin(v_policy, 'short_code');
    v_short_enabled := COALESCE((v_short_plugin->>'enabled')::BOOLEAN, FALSE);
    v_short_params := COALESCE(v_short_plugin->'params', '{}'::jsonb);
    v_short_country_gate := upper(NULLIF(v_short_params->>'country', ''));
    v_short_code_regex := COALESCE(NULLIF(v_short_params->>'code_regex', ''), '^[A-Z]{4}[0-9]{4}$');

    IF v_short_enabled AND NOT v_is_reverse THEN
        v_short_candidate := COALESCE(
            NULLIF(v_address.sa_short_code, ''),
            NULLIF(v_address.line1, '')
        );

        v_short_code := public.geocoding_normalize_candidate_code(v_short_candidate, v_short_code_regex);

        -- Only reject when an explicit (non-empty) country contradicts the plugin gate.
        IF v_short_country_gate IS NOT NULL
           AND v_short_country_gate <> ''
           AND NULLIF(v_address.country, '') IS NOT NULL
           AND upper(v_address.country) <> v_short_country_gate THEN
            v_short_code := NULL;
        END IF;

        IF v_short_code IS NOT NULL THEN
            v_address_text := v_short_code;
            v_address_in := NULLIF(v_short_params->>'here_in', '');
            v_address_types := NULLIF(v_short_params->>'here_types', '');
        END IF;
    END IF;

    IF NOT v_is_reverse AND (v_address_text IS NULL OR v_address_text = '') THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: normalized address unavailable for workflow_run_step %', p_step.id;
    END IF;

    v_template_metadata := COALESCE(v_template.metadata, '{}'::jsonb);
    v_template_query := COALESCE(v_template_metadata->'url_query_mapping', '[]'::jsonb);

    v_query_context := jsonb_strip_nulls(
        jsonb_build_object(
            'address', jsonb_strip_nulls(
                jsonb_build_object(
                    'text', v_address_text,
                    'lang', v_lang,
                    'limit', v_limit,
                    'in', v_address_in,
                    'types', v_address_types
                )
            ),
            'coordinates', jsonb_strip_nulls(
                COALESCE(
                    p_run.context->'geocoding'->'provided_coordinates',
                    p_run.context->'geocoding'->'selected_geocode'->'coordinates',
                    p_run.context->'shipment'->'coordinates'
                )
            ),
            'coordinates_text',
                CASE
                    WHEN COALESCE(
                        (p_run.context->'geocoding'->'provided_coordinates') IS NOT NULL,
                        (p_run.context->'geocoding'->'selected_geocode'->'coordinates') IS NOT NULL,
                        (p_run.context->'shipment'->'coordinates') IS NOT NULL
                    ) THEN concat_ws(
                        ',',
                        COALESCE(
                            (p_run.context->'geocoding'->'provided_coordinates'->>'latitude')::TEXT,
                            (p_run.context->'geocoding'->'selected_geocode'->'coordinates'->>'latitude')::TEXT,
                            (p_run.context->'shipment'->'coordinates'->>'latitude')::TEXT
                        ),
                        COALESCE(
                            (p_run.context->'geocoding'->'provided_coordinates'->>'longitude')::TEXT,
                            (p_run.context->'geocoding'->'selected_geocode'->'coordinates'->>'longitude')::TEXT,
                            (p_run.context->'shipment'->'coordinates'->>'longitude')::TEXT
                        )
                    )
                    ELSE NULL
                END,
            'provider', jsonb_strip_nulls(
                jsonb_build_object(
                    'name', v_provider.name
                )
            ),
            'policy', v_policy,
            'step', COALESCE(p_step.metadata, '{}'::jsonb),
            'run', jsonb_strip_nulls(
                jsonb_build_object(
                    'id', p_run.id,
                    'attempt_type', v_attempt_type
                )
            )
        )
    );

    v_query_string := '';
    FOR v_query_element IN SELECT * FROM jsonb_array_elements(v_template_query)
    LOOP
        IF COALESCE(v_query_element->>'param', '') = '' THEN
            CONTINUE;
        END IF;

        IF v_query_element->>'value_path' = '$.coordinates' AND v_is_reverse THEN
            v_value := to_jsonb(COALESCE(v_query_context->>'coordinates_text', ''));
        ELSE
            v_value := safe_jsonpath_query_first(
                v_query_context,
                COALESCE(v_query_element->>'value_path', '')
            );
        END IF;

        IF v_value IS NULL OR v_value = 'null'::jsonb THEN
            CONTINUE;
        END IF;

        v_value_text := CASE jsonb_typeof(v_value)
            WHEN 'string' THEN trim(both '\"' FROM v_value::TEXT)
            WHEN 'number' THEN v_value::TEXT
            ELSE v_value::TEXT
        END;

        IF v_value_text IS NULL OR v_value_text = '' THEN
            CONTINUE;
        END IF;

        v_query_string := v_query_string ||
            CASE WHEN v_query_string = '' THEN '' ELSE '&' END ||
            format('%s=%s',
                   COALESCE(v_query_element->>'param', ''),
                   public.urlencode(v_value_text));
    END LOOP;

    v_step_record := p_step;

    v_step_record.metadata := jsonb_strip_nulls(
        COALESCE(p_step.metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_template_id', v_template.id::TEXT,
            'override_url',
                v_template.url_template ||
                CASE
                    WHEN v_query_string IS NULL OR v_query_string = '' THEN ''
                    WHEN position('?' IN v_template.url_template) > 0 THEN '&' || v_query_string
                    ELSE '?' || v_query_string
                END,
            'provider_id', v_provider.id::TEXT,
            'provider_name', v_provider.name,
            'provider_sequence_index', v_sequence_index,
            'attempt_type', v_attempt_type,
            'lang', v_lang,
            'limit', v_limit,
            'reverse_geocode', CASE WHEN v_is_reverse THEN TRUE ELSE NULL END
        )
    );

    UPDATE workflow_run_steps
    SET metadata = v_step_record.metadata,
        updated_at = now()
    WHERE id = p_step.id;

    RETURN workflow_handlers.execute_outbound_http_v1(
        v_step_record,
        p_run,
        p_operation_result
    );
END;
$$;

ALTER FUNCTION workflow_handlers.execute_provider_dispatch_v1(workflow_run_steps, workflow_runs, jsonb)
  SET search_path TO workflow_handlers, public, extensions, pg_temp;

COMMIT;

