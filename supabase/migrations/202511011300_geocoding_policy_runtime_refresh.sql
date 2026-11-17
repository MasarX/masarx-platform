-- Migration: Geocoding policy runtime refresh
-- Purpose: Resolve provider selection, thresholds, and backpressure dynamically from geocoding_policy.

BEGIN;

-- Shared helper to resolve the effective geocoding policy and the scope it originated from.
CREATE OR REPLACE FUNCTION public.geocoding_resolve_policy(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID
)
RETURNS TABLE (
    policy JSONB,
    scope_type TEXT,
    scope_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_policy JSONB;
BEGIN
    IF p_sender_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'sender', p_sender_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'sender';
            scope_id := p_sender_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p_client_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'client', p_client_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'client';
            scope_id := p_client_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    IF p_organization_id IS NOT NULL THEN
        v_policy := public.resolve_settings('geocoding_policy', 'tenant', p_organization_id);
        IF v_policy IS NOT NULL THEN
            policy := v_policy;
            scope_type := 'tenant';
            scope_id := p_organization_id;
            RETURN NEXT;
            RETURN;
        END IF;
    END IF;

    v_policy := public.resolve_settings('geocoding_policy', 'global', NULL);
    IF v_policy IS NOT NULL THEN
        policy := v_policy;
        scope_type := 'global';
        scope_id := NULL;
        RETURN NEXT;
        RETURN;
    END IF;
END;
$$;

-- Tag geocoding operation templates with canonical metadata for policy-driven routing.
UPDATE operation_templates
SET metadata = jsonb_strip_nulls(
        COALESCE(metadata, '{}'::jsonb)
        || jsonb_build_object(
            'operation_role', 'geocoding_forward',
            'url_query_mapping',
                CASE operation_name
                    WHEN 'geocoding_here_forward_v1' THEN jsonb_build_array(
                        jsonb_build_object('param', 'q', 'value_path', '$.address.text'),
                        jsonb_build_object('param', 'lang', 'value_path', '$.address.lang'),
                        jsonb_build_object('param', 'limit', 'value_path', '$.address.limit'),
                        jsonb_build_object('param', 'apiKey', 'value_path', '$.provider.api_key')
                    )
                    WHEN 'geocoding_google_forward_v1' THEN jsonb_build_array(
                        jsonb_build_object('param', 'address', 'value_path', '$.address.text'),
                        jsonb_build_object('param', 'language', 'value_path', '$.address.lang'),
                        jsonb_build_object('param', 'key', 'value_path', '$.provider.api_key')
                    )
                    ELSE NULL
                END
        )
    )
WHERE operation_name IN ('geocoding_here_forward_v1', 'geocoding_google_forward_v1');

-- Normalize workflow step metadata for provider dispatch / fallback ordering.
UPDATE public.workflow_template_steps
SET metadata = jsonb_strip_nulls(
        (
            (COALESCE(metadata, '{}'::jsonb)
                - 'provider_id'
                - 'provider_key'
                - 'operation_template_id'
                - 'simulated_confidence')
            || jsonb_build_object(
                'provider_sequence_index', 0,
                'lang', COALESCE(NULLIF(metadata->>'lang', ''), 'en'),
                'limit', COALESCE(NULLIF(metadata->>'limit', '')::INT, 1)
            )
        )
    )
WHERE id = '99990000-0000-0000-0000-000000410004'::uuid;

UPDATE public.workflow_template_steps
SET metadata = jsonb_strip_nulls(
        (
            (COALESCE(metadata, '{}'::jsonb)
                - 'provider_id'
                - 'provider_key'
                - 'operation_template_id'
                - 'simulated_confidence')
            || jsonb_build_object(
                'provider_sequence_index', 1,
                'lang', COALESCE(NULLIF(metadata->>'lang', ''), 'en'),
                'limit', COALESCE(NULLIF(metadata->>'limit', '')::INT, 1)
            )
        )
    )
WHERE id = '99990000-0000-0000-0000-000000410006'::uuid;

-- Policy-driven provider dispatch (backpressure-aware).
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
    v_lang TEXT := COALESCE(NULLIF(v_metadata->>'lang', ''), 'en');
    v_limit INT := COALESCE((v_metadata->>'limit')::INT, 1);
    v_attempt_type TEXT := COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary');
    v_step_record workflow_run_steps%ROWTYPE;
    v_api_key TEXT;
    v_backpressure JSONB;
    v_queue_depth INT := 0;
    v_max_queue_depth INT;
    v_throttle_depth INT;
    v_delay_seconds INT;
    v_resume_seconds INT;
    v_response workflow_handler_response;
    v_value JSONB;
    v_value_text TEXT;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

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
        ELSIF v_throttle_depth IS NOT NULL AND v_queue_depth >= v_throttle_depth THEN
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
        SELECT value
        FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb))
    );

    v_sequence_index := COALESCE(
        (v_metadata->>'provider_sequence_index')::INT,
        CASE LOWER(v_attempt_type)
            WHEN 'fallback' THEN 1
            ELSE 0
        END
    );

    v_candidate_index := v_sequence_index;
    v_provider := NULL;
    v_template := NULL;

    WHILE v_candidate_index < COALESCE(array_length(v_provider_candidates, 1), 0) LOOP
        v_provider_name := v_provider_candidates[v_candidate_index + 1];

        IF v_provider_name IS NULL
           OR v_provider_name IN ('internal_cache', 'manual_review_virtual') THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        SELECT p.*
        INTO v_provider
        FROM public.providers p
        WHERE lower(p.name) = lower(v_provider_name)
          AND p.enabled IS TRUE
        ORDER BY
            CASE
                WHEN p.organization_id = v_ctx.organization_id THEN 0
                WHEN p.organization_id IS NULL THEN 1
                ELSE 2
            END,
            p.priority_rank NULLS LAST,
            p.created_at
        LIMIT 1;

        IF NOT FOUND THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        SELECT *
        INTO v_template
        FROM operation_templates ot
        WHERE ot.provider_id = v_provider.id
          AND COALESCE(ot.metadata->>'operation_role', '') = 'geocoding_forward'
        ORDER BY ot.updated_at DESC
        LIMIT 1;

        IF NOT FOUND THEN
            v_candidate_index := v_candidate_index + 1;
            CONTINUE;
        END IF;

        EXIT;
    END LOOP;

    IF v_template IS NULL OR v_provider IS NULL THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'skipped', TRUE,
            'reason', 'provider_priority_exhausted'
        );
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_build_object(
                'successful', FALSE,
                'manual_review_required', TRUE,
                'manual_review_reason', 'provider_priority_exhausted'
            )
        );
        RETURN v_response;
    END IF;

    v_sequence_index := v_candidate_index;

    SELECT credentials->>'api_key'
    INTO v_api_key
    FROM provider_auth_configs
    WHERE provider_id = v_provider.id
    ORDER BY created_at DESC
    LIMIT 1;

    IF v_api_key IS NULL OR v_api_key = '' THEN
        RAISE EXCEPTION 'execute_provider_dispatch_v1: API key missing for provider %', v_provider.name;
    END IF;

    SELECT
        COALESCE(a.normalized_line1, a.line1, a.raw_input->>'line1', '') AS line1,
        COALESCE(a.normalized_line2, a.line2, a.raw_input->>'line2', '') AS line2,
        COALESCE(a.district, '') AS district,
        COALESCE(a.city, a.raw_input->>'city', '') AS city,
        COALESCE(a.province, a.raw_input->>'province', '') AS province,
        COALESCE(a.country, a.raw_input->>'country', '') AS country
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

    IF v_address_text IS NULL OR v_address_text = '' THEN
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
                    'limit', v_limit
                )
            ),
            'provider', jsonb_strip_nulls(
                jsonb_build_object(
                    'api_key', v_api_key,
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

        v_value := safe_jsonpath_query_first(
            v_query_context,
            COALESCE(v_query_element->>'value_path', '')
        );

        IF v_value IS NULL OR v_value = 'null'::jsonb THEN
            CONTINUE;
        END IF;

        v_value_text := CASE jsonb_typeof(v_value)
            WHEN 'string' THEN trim(both '"' FROM v_value::TEXT)
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
            'limit', v_limit
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

-- Confidence evaluation driven by policy thresholds.
CREATE OR REPLACE FUNCTION workflow_handlers.execute_geo_decision_v1(
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
    v_primary_threshold NUMERIC(5,4);
    v_fallback_threshold NUMERIC(5,4);
    v_delta NUMERIC(5,4);
    v_attempt RECORD;
    v_success BOOLEAN := FALSE;
    v_requires_fallback BOOLEAN := FALSE;
    v_manual_review BOOLEAN := FALSE;
    v_selected_confidence NUMERIC(5,4);
    v_response workflow_handler_response;
    v_attempt_json JSONB;
    v_attempt_id UUID;
    v_attempt_geocode JSONB;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', FALSE);

    SELECT *
    INTO v_ctx
    FROM geocoding_extract_context(p_run);

    IF v_ctx.address_id IS NULL THEN
        RAISE EXCEPTION 'execute_geo_decision_v1: address_id unavailable for workflow_run %', p_step.workflow_run_id;
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

    v_primary_threshold := COALESCE(
        (v_policy->>'confidence_threshold')::NUMERIC,
        (v_metadata->>'confidence_threshold')::NUMERIC,
        0.75
    );

    v_fallback_threshold := COALESCE(
        (v_policy->>'fallback_threshold')::NUMERIC,
        (v_policy->'metadata'->>'fallback_threshold')::NUMERIC,
        (v_metadata->>'fallback_threshold')::NUMERIC,
        NULL
    );

    IF v_fallback_threshold IS NULL AND v_primary_threshold IS NOT NULL THEN
        v_delta := COALESCE(
            (v_policy->'provider_agreement_rules'->>'min_confidence_delta')::NUMERIC,
            0.1
        );
        v_fallback_threshold := v_primary_threshold - v_delta;
    END IF;

    v_fallback_threshold := COALESCE(v_fallback_threshold, 0.65);
    IF v_primary_threshold IS NOT NULL THEN
        v_fallback_threshold := LEAST(v_primary_threshold, v_fallback_threshold);
    END IF;

    SELECT *
    INTO v_attempt
    FROM public.geocoding_attempts
    WHERE address_id = v_ctx.address_id
    ORDER BY created_at DESC
    LIMIT 1;

    IF NOT FOUND THEN
        v_manual_review := TRUE;
        v_attempt_id := NULL;
        v_attempt_geocode := NULL;
    ELSE
        v_attempt_id := v_attempt.id;
        v_attempt_geocode := COALESCE(v_attempt.metadata->'geocode', NULL);
        v_selected_confidence := COALESCE(v_attempt.confidence, 0);

        IF v_selected_confidence >= v_primary_threshold THEN
            v_success := TRUE;
        ELSIF v_selected_confidence >= v_fallback_threshold THEN
            IF v_attempt.attempt_type = 'fallback' THEN
                v_success := TRUE;
            ELSE
                v_requires_fallback := TRUE;
            END IF;
        ELSE
            IF v_attempt.attempt_type = 'fallback' THEN
                v_manual_review := TRUE;
            ELSE
                v_requires_fallback := TRUE;
            END IF;
        END IF;
    END IF;

    IF v_success THEN
        v_attempt_json := jsonb_build_object(
            'attempt_id', v_attempt_id,
            'provider_name', v_attempt.provider_name,
            'confidence', v_selected_confidence,
            'attempt_type', v_attempt.attempt_type,
            'geocode', v_attempt_geocode
        );

        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', TRUE,
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'manual_review_required', FALSE,
                'thresholds', jsonb_build_object(
                    'primary', v_primary_threshold,
                    'fallback', v_fallback_threshold
                )
            ))
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'success',
            'attempt', v_attempt_json
        );
        RETURN v_response;
    END IF;

    IF v_requires_fallback THEN
        v_response.context_patch := jsonb_build_object(
            'geocoding', jsonb_strip_nulls(jsonb_build_object(
                'successful', FALSE,
                'selected_attempt_id', v_attempt_id,
                'selected_geocode', v_attempt_geocode,
                'manual_review_required', FALSE,
                'require_fallback', TRUE,
                'thresholds', jsonb_build_object(
                    'primary', v_primary_threshold,
                    'fallback', v_fallback_threshold
                )
            ))
        );

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object(
            'decision', 'fallback_required',
            'last_attempt_id', v_attempt_id
        );
        RETURN v_response;
    END IF;

    v_manual_review := TRUE;

    v_response.context_patch := jsonb_build_object(
        'geocoding', jsonb_strip_nulls(jsonb_build_object(
            'successful', FALSE,
            'manual_review_required', TRUE,
            'manual_review_reason', 'confidence_below_threshold',
            'selected_attempt_id', v_attempt_id,
            'selected_geocode', v_attempt_geocode,
            'thresholds', jsonb_build_object(
                'primary', v_primary_threshold,
                'fallback', v_fallback_threshold
            )
        ))
    );

    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
        'decision', 'manual_review',
        'reason', 'confidence_below_threshold'
    );
    RETURN v_response;
END;
$$;

COMMIT;
