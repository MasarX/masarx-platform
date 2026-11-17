-- Migration: Geocoding security hardening
-- Purpose: Remove seeded provider credentials, tighten RLS policies, and enforce service-role execution.

BEGIN;

SELECT pg_advisory_lock(hashtext('202511011400_geocoding_security_hardening'));
SET search_path TO public;

-- Remove any previously seeded HERE geocoding API key.
WITH here_provider AS (
    SELECT id
    FROM providers
    WHERE name = 'here_geocoding'
    LIMIT 1
)
DELETE FROM provider_auth_configs
WHERE provider_id = (SELECT id FROM here_provider)
  AND auth_type = 'api_key';

WITH dialog_provider AS (
    SELECT id
    FROM providers
    WHERE name = 'dialog360_whatsapp'
    LIMIT 1
)
DELETE FROM provider_auth_configs
WHERE provider_id = (SELECT id FROM dialog_provider)
  AND auth_type = 'api_key';

WITH logestechs_provider AS (
    SELECT id
    FROM providers
    WHERE name = 'logestechs_3pl'
    LIMIT 1
)
DELETE FROM provider_auth_configs
WHERE provider_id = (SELECT id FROM logestechs_provider)
  AND auth_type = 'basic_auth';

WITH twilio_provider AS (
    SELECT id
    FROM providers
    WHERE name = 'twilio_sms'
    LIMIT 1
)
DELETE FROM provider_auth_configs
WHERE provider_id = (SELECT id FROM twilio_provider)
  AND auth_type = 'hmac';

-- Harden RLS policies for geocoding tables.
DROP POLICY IF EXISTS geocoding_attempts_rls_policy ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_attempts_select_authenticated ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_attempts_select_manual ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_attempts_worker_mutation ON public.geocoding_attempts;
DROP POLICY IF EXISTS geocoding_attempts_service_role ON public.geocoding_attempts;

DROP POLICY IF EXISTS geocodes_rls_policy ON public.geocodes;
DROP POLICY IF EXISTS geocodes_select_authenticated ON public.geocodes;
DROP POLICY IF EXISTS geocodes_select_manual ON public.geocodes;
DROP POLICY IF EXISTS geocodes_worker_mutation ON public.geocodes;
DROP POLICY IF EXISTS geocodes_service_role ON public.geocodes;

CREATE POLICY geocoding_attempts_select_authenticated
    ON public.geocoding_attempts
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY geocoding_attempts_select_manual
    ON public.geocoding_attempts
    FOR SELECT
    TO geocoding_manual_role
    USING (organization_id = current_user_org_id());

CREATE POLICY geocoding_attempts_worker_mutation
    ON public.geocoding_attempts
    FOR ALL
    TO geocoding_worker_role
    USING (
        current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
        OR organization_id = current_user_org_id()
    )
    WITH CHECK (
        current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
        OR organization_id = current_user_org_id()
    );

CREATE POLICY geocoding_attempts_service_role
    ON public.geocoding_attempts
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

CREATE POLICY geocodes_select_authenticated
    ON public.geocodes
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

CREATE POLICY geocodes_select_manual
    ON public.geocodes
    FOR SELECT
    TO geocoding_manual_role
    USING (organization_id = current_user_org_id());

CREATE POLICY geocodes_worker_mutation
    ON public.geocodes
    FOR ALL
    TO geocoding_worker_role
    USING (
        current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
        OR organization_id = current_user_org_id()
    )
    WITH CHECK (
        current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
        OR organization_id = current_user_org_id()
    );

CREATE POLICY geocodes_service_role
    ON public.geocodes
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

-- Require service-role execution for provider dispatch helper.
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
    PERFORM public.geocoding_assert_service_role();

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

SELECT pg_advisory_unlock(hashtext('202511011400_geocoding_security_hardening'));

COMMIT;
