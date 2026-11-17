-- Migration: Labels print bundle scope enforcement (sender/client)
-- Purpose: Enforce webhook source sender/client scoping when execute_label_bundle_v1 derives labels from payload shipments.
-- Date: 2025-12-15

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION workflow_handlers.execute_label_bundle_v1(
    p_step public.workflow_run_steps,
    p_run public.workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $$
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

    v_async_state JSONB := COALESCE(v_label_state->'bundle_async', '{}'::jsonb);
    v_async_request_id BIGINT := NULLIF(v_async_state->>'request_id', '')::BIGINT;
    v_async_attempts INT := COALESCE((v_async_state->>'attempts')::INT, 0);
    v_async_requested_at TIMESTAMPTZ := NULLIF(v_async_state->>'requested_at', '')::TIMESTAMPTZ;
    v_request_payload JSONB;

    v_http_response JSONB;
    v_http_body JSONB;
    v_bundle JSONB := NULL;

    v_success BOOLEAN := FALSE;
    v_status TEXT;
    v_first_url TEXT;
    v_next_poll_at TIMESTAMPTZ;
    v_quick_attempt INT;

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
        resolve_settings('label_print_policy', 'tenant', v_org_id),
        resolve_settings('label_print_policy', 'global', NULL),
        '{}'::jsonb
    );

    v_defaults := COALESCE(
        resolve_settings('label_print_defaults', 'tenant', v_org_id),
        resolve_settings('label_print_defaults', 'global', NULL),
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

    v_allow_synthesize := COALESCE(
        (v_defaults->>'synthesize_from_existing')::BOOLEAN,
        FALSE
    );

    -- Ensure we have ready labels; derive from payload if prepare skipped (scoped)
    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
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
            FROM labels l
            JOIN public.shipments sh ON sh.id = l.shipment_id
            WHERE l.shipment_id = ANY (
                SELECT (ship->>'shipment_id')::uuid FROM jsonb_array_elements(v_shipments) ship
            )
              AND sh.organization_id = v_org_id
              AND (v_scope_client_id IS NULL OR sh.client_id = v_scope_client_id)
              AND (v_scope_sender_id IS NULL OR sh.sender_id = v_scope_sender_id);
        END IF;
    END IF;

    IF COALESCE(jsonb_array_length(v_ready), 0) = 0 THEN
        v_response.status := 'completed';
        v_response.operation_result := jsonb_build_object('status', 'skipped', 'reason', 'no_ready_labels');
        RETURN v_response;
    END IF;

    IF jsonb_array_length(v_ready) > v_max_labels THEN
        RAISE EXCEPTION 'execute_label_bundle_v1: ready labels (%) exceed max bundle limit (%)',
            jsonb_array_length(v_ready), v_max_labels;
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

    v_request_payload := COALESCE(v_async_state->'request_payload', v_bundle_payload);

    IF v_async_request_id IS NOT NULL THEN
        v_http_response := check_async_response(v_async_request_id);
        IF NOT COALESCE(v_http_response->>'completed', 'false')::BOOLEAN THEN
            FOR v_quick_attempt IN 1..5 LOOP
                PERFORM pg_sleep(0.3);
                v_http_response := check_async_response(v_async_request_id);
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
        v_http_response := invoke_label_renderer(NULL, v_request_payload);
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

            FOR v_quick_attempt IN 1..5 LOOP
                PERFORM pg_sleep(0.3);
                v_http_response := check_async_response(v_async_request_id);
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

    -- Parse the provider body once we have a completed response (synchronous or async).
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
$$;

COMMENT ON FUNCTION workflow_handlers.execute_label_bundle_v1(public.workflow_run_steps, public.workflow_runs, JSONB)
    IS 'Bundle labels via edge with async polling; persists bundle_response once provider completion is confirmed.';

COMMIT;

