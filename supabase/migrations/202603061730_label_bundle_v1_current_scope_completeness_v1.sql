-- Migration: label bundle v1 current-scope completeness guard
-- Purpose:
--  - Prevent partial fresh-scope bundles from starting before all current-scope labels are ready.
--  - Drop stale async bundle requests whose payload no longer matches the current fresh label set.
--  - Fail closed when a returned bundle reports fewer labels than the fresh current-scope expectation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061730_label_bundle_v1_current_scope_completeness_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result jsonb DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
    v_response public.workflow_handler_response;
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_label_state JSONB := COALESCE(v_context->'label_print', '{}'::jsonb);
    v_policy JSONB;
    v_defaults JSONB;
    v_options JSONB := COALESCE(v_label_state->'options', '{}'::jsonb);
    v_ready JSONB := COALESCE(v_label_state->'ready', '[]'::jsonb);
    v_counts JSONB := COALESCE(v_label_state->'counts', '{}'::jsonb);
    v_org_id UUID := NULLIF(v_label_state->>'organization_id', '')::uuid;
    v_expires_seconds INT;
    v_max_labels INT;
    v_poll_interval_seconds INT;
    v_bundle_payload JSONB;
    v_label_ids JSONB := '[]'::jsonb;
    v_file_urls JSONB := '[]'::jsonb;
    v_shipments JSONB;
    v_allow_synthesize BOOLEAN := FALSE;
    v_fresh_generation_required BOOLEAN := FALSE;
    v_fresh_resolve_mode TEXT := 'legacy_or_current';
    v_fresh_scope_only BOOLEAN := FALSE;
    v_expected_count INT := 0;
    v_pending_count INT := 0;
    v_ready_count_actual INT := 0;

    v_async_state JSONB := COALESCE(v_label_state->'bundle_async', '{}'::jsonb);
    v_async_request_id BIGINT := NULLIF(v_async_state->>'request_id', '')::BIGINT;
    v_async_attempts INT := COALESCE((v_async_state->>'attempts')::INT, 0);
    v_async_requested_at TIMESTAMPTZ := NULLIF(v_async_state->>'requested_at', '')::TIMESTAMPTZ;
    v_request_payload JSONB;
    v_async_payload_label_ids JSONB := '[]'::jsonb;
    v_async_payload_matches_current BOOLEAN := FALSE;

    v_http_response JSONB;
    v_http_body JSONB;
    v_bundle JSONB := NULL;

    v_success BOOLEAN := FALSE;
    v_status TEXT;
    v_first_url TEXT;
    v_next_poll_at TIMESTAMPTZ;
    v_quick_attempt INT := 0;
    v_quick_poll_attempts INT := 3;
    v_quick_poll_interval_ms INT := 75;
    v_bundle_requested_count INT := 0;
    v_bundle_bundled_count INT := 0;

    v_webhook_source_id UUID := NULLIF(v_context->>'webhook_source_id', '')::uuid;
    v_scope_sender_id UUID;
    v_scope_client_id UUID;
BEGIN
    IF v_org_id IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: organization_id missing from context';
    END IF;

    IF v_webhook_source_id IS NOT NULL THEN
        SELECT ws.sender_id, s.client_id
        INTO v_scope_sender_id, v_scope_client_id
        FROM public.webhook_sources ws
        LEFT JOIN public.senders s ON s.id = ws.sender_id
        WHERE ws.id = v_webhook_source_id;
    END IF;

    v_policy := COALESCE(
        v_label_state->'policy',
        public.resolve_settings('label_print_policy', 'tenant', v_org_id),
        public.resolve_settings('label_print_policy', 'global', NULL),
        '{}'::jsonb
    );

    v_defaults := COALESCE(
        public.resolve_settings('label_print_defaults', 'tenant', v_org_id),
        public.resolve_settings('label_print_defaults', 'global', NULL),
        '{}'::jsonb
    );

    v_expires_seconds := COALESCE(
        NULLIF(v_options->>'expires_seconds', '')::INT,
        NULLIF(v_policy->>'default_expires_seconds', '')::INT,
        NULLIF(v_defaults->>'default_expires_seconds', '')::INT
    );

    IF v_expires_seconds IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: default_expires_seconds missing for organization %', v_org_id;
    END IF;

    v_max_labels := COALESCE(
        NULLIF(v_policy->>'max_labels_per_bundle', '')::INT,
        NULLIF(v_defaults->>'max_labels_per_bundle', '')::INT
    );

    IF v_max_labels IS NULL THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: max_labels_per_bundle missing for organization %', v_org_id;
    END IF;

    v_poll_interval_seconds := COALESCE(
        NULLIF(v_options->>'poll_interval_seconds', '')::INT,
        NULLIF(v_policy->>'poll_interval_seconds', '')::INT,
        30
    );
    IF v_poll_interval_seconds < 1 THEN
        v_poll_interval_seconds := 30;
    END IF;

    v_quick_poll_attempts := LEAST(
        GREATEST(
            COALESCE(
                NULLIF(v_options->>'quick_poll_attempts', '')::INT,
                NULLIF(v_policy->>'quick_poll_attempts', '')::INT,
                3
            ),
            0
        ),
        20
    );
    v_quick_poll_interval_ms := LEAST(
        GREATEST(
            COALESCE(
                NULLIF(v_options->>'quick_poll_interval_ms', '')::INT,
                NULLIF(v_policy->>'quick_poll_interval_ms', '')::INT,
                75
            ),
            25
        ),
        2000
    );

    v_allow_synthesize := COALESCE(
        NULLIF(v_defaults->>'synthesize_from_existing', '')::BOOLEAN,
        FALSE
    );
    v_fresh_generation_required := COALESCE(
        NULLIF(v_label_state->>'fresh_generation_required', '')::BOOLEAN,
        NULLIF(v_policy->>'fresh_generation_required', '')::BOOLEAN,
        FALSE
    );
    v_fresh_resolve_mode := lower(
        COALESCE(
            NULLIF(v_label_state->>'fresh_resolve_mode', ''),
            NULLIF(v_policy->>'fresh_resolve_mode', ''),
            'legacy_or_current'
        )
    );
    v_fresh_scope_only := v_fresh_generation_required AND v_fresh_resolve_mode = 'workflow_scope_only';
    v_expected_count := COALESCE(
        NULLIF(v_counts->>'expected', '')::INT,
        COALESCE(jsonb_array_length(v_ready), 0)
    );
    v_pending_count := COALESCE(
        NULLIF(v_counts->>'pending', '')::INT,
        GREATEST(v_expected_count - COALESCE(jsonb_array_length(v_ready), 0), 0)
    );

    IF v_fresh_scope_only THEN
        v_allow_synthesize := FALSE;
    END IF;

    -- Fresh-only mode must never rebuild readiness from global latest labels.
    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
        IF v_fresh_scope_only AND (v_expected_count > 0 OR v_pending_count > 0) THEN
            v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
            v_response.status := 'pending';
            v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
                'status', 'pending',
                'reason', 'waiting_for_fresh_ready_labels',
                'expected_count', v_expected_count,
                'pending_count', v_pending_count
            ));
            v_response.next_run_at := v_next_poll_at;
            v_response.context_patch := jsonb_build_object(
                'label_print',
                jsonb_strip_nulls(jsonb_build_object(
                    'organization_id', v_org_id,
                    'counts', v_counts,
                    'options', v_options,
                    'policy', v_policy,
                    'ready', v_ready,
                    'bundle_response', NULL,
                    'bundle_async', NULL
                ))
            );
            RETURN v_response;
        END IF;

        v_shipments := COALESCE(v_context->'payload'->'shipments', '[]'::jsonb);
        IF COALESCE(jsonb_array_length(v_shipments), 0) > 0 THEN
            SELECT COALESCE(jsonb_agg(jsonb_build_object(
                'shipment_id', l.shipment_id,
                'shipment_box_id', NULL,
                'box_number', NULL,
                'label_id', l.id,
                'file_url', l.file_url,
                'label_type', l.label_type,
                'generated_at', l.generated_at
            )), '[]'::jsonb)
            INTO v_ready
            FROM public.labels l
            JOIN public.shipments sh ON sh.id = l.shipment_id
            WHERE l.shipment_id = ANY (
                SELECT (ship->>'shipment_id')::uuid FROM jsonb_array_elements(v_shipments) ship
            )
              AND sh.organization_id = v_org_id
              AND (v_scope_client_id IS NULL OR sh.client_id = v_scope_client_id)
              AND (v_scope_sender_id IS NULL OR sh.sender_id = v_scope_sender_id);
        END IF;
    END IF;

    v_ready_count_actual := COALESCE(jsonb_array_length(v_ready), 0);

    IF v_fresh_scope_only AND v_expected_count > 0
       AND (v_ready_count_actual < v_expected_count OR v_pending_count > 0) THEN
        v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
        v_response.status := 'pending';
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'status', 'pending',
            'reason', 'waiting_for_full_fresh_ready_labels',
            'expected_count', v_expected_count,
            'ready_count', v_ready_count_actual,
            'pending_count', GREATEST(v_pending_count, 0)
        ));
        v_response.next_run_at := v_next_poll_at;
        v_response.context_patch := jsonb_build_object(
            'label_print',
            jsonb_strip_nulls(jsonb_build_object(
                'organization_id', v_org_id,
                'counts', v_counts,
                'options', v_options,
                'policy', v_policy,
                'ready', v_ready,
                'bundle_response', NULL,
                'bundle_async', NULL
            ))
        );
        RETURN v_response;
    END IF;

    IF v_ready_count_actual = 0 THEN
        IF v_fresh_scope_only AND (v_expected_count > 0 OR v_pending_count > 0) THEN
            v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
            v_response.status := 'pending';
            v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
                'status', 'pending',
                'reason', 'waiting_for_fresh_ready_labels',
                'expected_count', v_expected_count,
                'pending_count', v_pending_count
            ));
            v_response.next_run_at := v_next_poll_at;
            v_response.context_patch := jsonb_build_object(
                'label_print',
                jsonb_strip_nulls(jsonb_build_object(
                    'organization_id', v_org_id,
                    'counts', v_counts,
                    'options', v_options,
                    'policy', v_policy,
                    'ready', v_ready,
                    'bundle_response', NULL,
                    'bundle_async', NULL
                ))
            );
            RETURN v_response;
        END IF;

        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('status', 'skipped', 'reason', 'no_ready_labels');
        RETURN v_response;
    END IF;

    IF v_ready_count_actual > v_max_labels THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: ready labels (%) exceed max bundle limit (%)',
            v_ready_count_actual, v_max_labels;
    END IF;

    v_label_ids := COALESCE((SELECT jsonb_agg(elem->'label_id') FROM jsonb_array_elements(v_ready) elem), '[]'::jsonb);
    v_file_urls := COALESCE((SELECT jsonb_agg(elem->'file_url') FROM jsonb_array_elements(v_ready) elem), '[]'::jsonb);

    v_bundle_payload := jsonb_build_object(
        'bundle', jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'file_urls', v_file_urls,
            'label_ids', v_label_ids,
            'expires_seconds', v_expires_seconds,
            'metadata', jsonb_build_object('counts', v_counts, 'options', v_options)
        ))
    );

    v_request_payload := v_bundle_payload;
    IF v_async_request_id IS NOT NULL THEN
        v_async_payload_label_ids := COALESCE(v_async_state #> '{request_payload,bundle,label_ids}', '[]'::jsonb);
        v_async_payload_matches_current := (
            COALESCE(jsonb_typeof(v_async_payload_label_ids), '') = 'array'
            AND v_async_payload_label_ids = v_label_ids
            AND COALESCE(jsonb_array_length(v_async_payload_label_ids), 0) = COALESCE(jsonb_array_length(v_label_ids), 0)
        );

        IF v_fresh_scope_only AND NOT v_async_payload_matches_current THEN
            v_async_request_id := NULL;
            v_async_attempts := 0;
            v_async_requested_at := NULL;
            v_async_state := '{}'::jsonb;
        ELSE
            v_request_payload := COALESCE(v_async_state->'request_payload', v_bundle_payload);
        END IF;
    END IF;

    IF v_async_request_id IS NOT NULL THEN
        v_http_response := public.check_async_response(v_async_request_id);
        IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN THEN
            FOR v_quick_attempt IN 1..v_quick_poll_attempts LOOP
                PERFORM pg_sleep((v_quick_poll_interval_ms::numeric) / 1000.0);
                v_http_response := public.check_async_response(v_async_request_id);
                EXIT WHEN COALESCE(v_http_response->>'completed', 'false')::BOOLEAN;
            END LOOP;
        END IF;

        IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN
           AND v_allow_synthesize
           AND COALESCE(jsonb_array_length(v_file_urls), 0) > 0 THEN
            SELECT elem
            INTO v_first_url
            FROM jsonb_array_elements_text(v_file_urls) AS elem
            LIMIT 1;

            IF v_first_url IS NOT NULL THEN
                v_bundle := jsonb_strip_nulls(jsonb_build_object(
                    'status', 'ok',
                    'bundle_id', gen_random_uuid(),
                    'file_path', v_first_url
                ));
                v_http_response := jsonb_build_object(
                    'status', 200,
                    'completed', TRUE,
                    'body', v_bundle
                );
            END IF;
        END IF;

        IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN THEN
            v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
            v_response.status := 'pending';
            v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
                'status', 'pending',
                'request_id', v_async_request_id,
                'poll_sql', (v_async_state->>'poll_sql')
            ));
            v_response.next_run_at := v_next_poll_at;
            v_response.context_patch := jsonb_build_object(
                'label_print',
                jsonb_strip_nulls(jsonb_build_object(
                    'organization_id', v_org_id,
                    'counts', v_counts,
                    'options', v_options,
                    'policy', v_policy,
                    'ready', v_ready,
                    'bundle_async', jsonb_strip_nulls(jsonb_build_object(
                        'request_id', v_async_request_id,
                        'attempts', v_async_attempts + 1,
                        'last_polled_at', now(),
                        'requested_at', COALESCE(v_async_requested_at, now()),
                        'request_payload', v_request_payload,
                        'poll_interval_seconds', v_poll_interval_seconds,
                        'poll_sql', (v_async_state->>'poll_sql')
                    ))
                ))
            );
            RETURN v_response;
        END IF;
    ELSE
        v_http_response := public.invoke_label_renderer(NULL, v_request_payload);
        IF NOT COALESCE(v_http_response->>'completed', 'true')::BOOLEAN THEN
            v_async_request_id := NULLIF(v_http_response->>'request_id', '')::BIGINT;
            v_async_state := jsonb_strip_nulls(jsonb_build_object(
                'request_id', v_async_request_id,
                'attempts', 0,
                'requested_at', now(),
                'request_payload', v_request_payload,
                'poll_interval_seconds', v_poll_interval_seconds,
                'poll_sql', COALESCE((v_http_response->'body')->>'poll_sql', NULL)
            ));

            FOR v_quick_attempt IN 1..v_quick_poll_attempts LOOP
                PERFORM pg_sleep((v_quick_poll_interval_ms::numeric) / 1000.0);
                v_http_response := public.check_async_response(v_async_request_id);
                EXIT WHEN COALESCE(v_http_response->>'completed', 'false')::BOOLEAN;
            END LOOP;

            IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN
               AND v_allow_synthesize
               AND COALESCE(jsonb_array_length(v_file_urls), 0) > 0 THEN
                SELECT elem
                INTO v_first_url
                FROM jsonb_array_elements_text(v_file_urls) AS elem
                LIMIT 1;

                IF v_first_url IS NOT NULL THEN
                    v_bundle := jsonb_strip_nulls(jsonb_build_object(
                        'status', 'ok',
                        'bundle_id', gen_random_uuid(),
                        'file_path', v_first_url
                    ));
                    v_http_response := jsonb_build_object(
                        'status', 200,
                        'completed', TRUE,
                        'body', v_bundle
                    );
                END IF;
            END IF;

            IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN THEN
                v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
                v_response.status := 'pending';
                v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
                    'status', 'pending',
                    'request_id', v_async_request_id,
                    'provider_status', v_http_response->>'status',
                    'poll_sql', COALESCE((v_http_response->'body')->>'poll_sql', NULL)
                ));
                v_response.next_run_at := v_next_poll_at;
                v_response.context_patch := jsonb_build_object(
                    'label_print',
                    jsonb_strip_nulls(jsonb_build_object(
                        'organization_id', v_org_id,
                        'counts', v_counts,
                        'options', v_options,
                        'policy', v_policy,
                        'ready', v_ready,
                        'bundle_async', v_async_state
                    ))
                );
                RETURN v_response;
            END IF;
        END IF;
    END IF;

    IF v_http_response ? 'body' THEN
        IF jsonb_typeof(v_http_response->'body') = 'string' THEN
            BEGIN
                v_http_body := (v_http_response->>'body')::jsonb;
            EXCEPTION WHEN others THEN
                v_http_body := jsonb_build_object('raw_body', v_http_response->>'body');
            END;
        ELSE
            v_http_body := v_http_response->'body';
        END IF;
    ELSE
        v_http_body := v_http_response;
    END IF;

    v_bundle := COALESCE(v_http_body->'bundle', v_http_body, '{}'::jsonb);

    IF COALESCE(v_bundle #>> '{counts,requested}', '') ~ '^\d+$' THEN
        v_bundle_requested_count := (v_bundle #>> '{counts,requested}')::INT;
    END IF;
    IF COALESCE(v_bundle #>> '{counts,bundled}', '') ~ '^\d+$' THEN
        v_bundle_bundled_count := (v_bundle #>> '{counts,bundled}')::INT;
    END IF;

    v_status := NULLIF(btrim(COALESCE(v_bundle->>'status', '')), '');
    v_success := (
        (v_bundle ? 'bundle_id')
        OR (v_bundle ? 'file_path')
        OR (v_bundle ? 'file_url')
        OR (v_bundle ? 'signed_url')
        OR (v_status IN ('ok', 'completed'))
    );

    IF NOT v_success AND v_allow_synthesize THEN
        SELECT elem INTO v_first_url
        FROM jsonb_array_elements_text(v_file_urls) AS elem
        LIMIT 1;

        IF v_first_url IS NOT NULL THEN
            v_bundle := jsonb_strip_nulls(jsonb_build_object(
                'status', 'ok',
                'bundle_id', gen_random_uuid(),
                'file_path', v_first_url
            ));
            v_success := TRUE;
        END IF;
    END IF;

    IF NOT v_success THEN
        v_response.status := 'failed';
        v_response.workflow_status := 'failed';
        v_response.last_error := COALESCE(v_bundle->>'error', v_http_response->>'error', 'label_bundle_failed');
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'status', 'failed',
            'provider_status', v_status,
            'bundle', v_bundle
        ));
        v_response.context_patch := jsonb_build_object(
            'label_print',
            jsonb_strip_nulls(jsonb_build_object(
                'organization_id', v_org_id,
                'counts', v_counts,
                'options', v_options,
                'policy', v_policy,
                'ready', v_ready,
                'bundle_async', NULL
            ))
        );
        RETURN v_response;
    END IF;

    IF v_fresh_scope_only AND v_expected_count > 0 AND (
        (v_bundle_requested_count > 0 AND v_bundle_requested_count < v_expected_count)
        OR (v_bundle_bundled_count > 0 AND v_bundle_bundled_count < v_expected_count)
    ) THEN
        v_next_poll_at := now() + make_interval(secs => v_poll_interval_seconds);
        v_response.status := 'pending';
        v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
            'status', 'pending',
            'reason', 'waiting_for_full_fresh_bundle',
            'expected_count', v_expected_count,
            'bundle_requested_count', NULLIF(v_bundle_requested_count, 0),
            'bundle_bundled_count', NULLIF(v_bundle_bundled_count, 0)
        ));
        v_response.next_run_at := v_next_poll_at;
        v_response.context_patch := jsonb_build_object(
            'label_print',
            jsonb_strip_nulls(jsonb_build_object(
                'organization_id', v_org_id,
                'counts', v_counts,
                'options', v_options,
                'policy', v_policy,
                'ready', v_ready,
                'bundle_response', NULL,
                'bundle_async', NULL
            ))
        );
        RETURN v_response;
    END IF;

    v_bundle := jsonb_strip_nulls(v_bundle);

    v_response.status := 'completed';
    v_response.operation_result := jsonb_strip_nulls(jsonb_build_object(
        'status', 'ok',
        'bundle', v_bundle
    ));
    v_response.context_patch := jsonb_build_object(
        'label_print',
        jsonb_strip_nulls(jsonb_build_object(
            'organization_id', v_org_id,
            'counts', v_counts,
            'options', v_options,
            'policy', v_policy,
            'ready', v_ready,
            'bundle_response', v_bundle,
            'bundle_async', NULL
        ))
    );

    RETURN v_response;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v1(public.workflow_run_steps, public.workflow_runs, jsonb)
  IS 'Invoke label renderer bundle mode and persist returned metadata with policy-driven quick rechecks; fresh workflow-scope mode now waits for full current-scope readiness and rejects stale partial bundles.';

UPDATE public.operation_handlers
SET notes = 'Call label renderer bundle mode with fresh-only completeness guards, stale async payload rejection, and policy-driven quick async rechecks.',
    doc_url = 'docs/ops/runbooks/label_renderer_runbook.md#bundle',
    updated_at = now()
WHERE handler_key = 'label_bundle';

SELECT pg_advisory_unlock(hashtext('202603061730_label_bundle_v1_current_scope_completeness_v1'));
COMMIT;
