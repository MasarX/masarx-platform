-- Migration: Restore label job decision logging and harden domain event dispatch
-- Purpose:
--   * Reintroduce decision_log writes for label job enqueue and completion paths.
--   * Guard domain_events worker against orphaned organization references to keep
--     the workflow engine resilient and fully dynamic.

BEGIN;

SET search_path TO public;

-------------------------------------------------------------------------------
-- Label job decision logging (request + completion paths)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION request_label_generation(
    p_shipment_id UUID,
    p_label_type TEXT,
    p_requested_by UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT NULL,
    p_shipment_box_id UUID DEFAULT NULL,
    p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_shipment RECORD;
    v_box shipment_boxes%ROWTYPE;
    v_template RECORD;
    v_job_id UUID;
    v_idempotency_key TEXT;
    v_retry_backoff JSONB;
    v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
    v_inserted BOOLEAN := FALSE;
BEGIN
    IF p_label_type IS NULL OR trim(p_label_type) = '' THEN
        RAISE EXCEPTION 'Label type is required.';
    END IF;

    SELECT
        s.id,
        s.organization_id,
        s.client_id,
        s.sender_id
    INTO v_shipment
    FROM shipments s
    WHERE s.id = p_shipment_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Shipment % not found', p_shipment_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_shipment.organization_id THEN
            RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
        END IF;
    END IF;

    IF p_shipment_box_id IS NOT NULL THEN
        SELECT *
        INTO v_box
        FROM shipment_boxes
        WHERE id = p_shipment_box_id
          AND shipment_id = p_shipment_id;

        IF NOT FOUND THEN
            RAISE EXCEPTION 'Shipment box % does not belong to shipment %', p_shipment_box_id, p_shipment_id;
        END IF;
    END IF;

    SELECT *
    INTO v_template
    FROM resolve_label_template(
        v_shipment.organization_id,
        v_shipment.client_id,
        v_shipment.sender_id,
        p_label_type
    )
    LIMIT 1;

    IF v_template.template_id IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve label template for shipment % label_type %', p_shipment_id, p_label_type;
    END IF;

    v_retry_backoff := COALESCE(v_template.retry_backoff, '[]'::jsonb);
    v_idempotency_key := format(
        '%s:%s:%s:%s:%s:%s',
        v_shipment.organization_id,
        p_shipment_id,
        COALESCE(p_shipment_box_id::text, '00000000-0000-0000-0000-000000000000'),
        lower(p_label_type),
        v_template.template_id,
        v_job_purpose
    );

    INSERT INTO label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_type,
        template_id,
        template_version,
        template_snapshot,
        status,
        attempts,
        max_attempts,
        scheduled_at,
        job_purpose,
        idempotency_key,
        requested_by,
        requested_source,
        renderer_hint,
        retry_state
    )
    VALUES (
        v_shipment.organization_id,
        v_shipment.client_id,
        p_shipment_id,
        p_shipment_box_id,
        lower(p_label_type),
        v_template.template_id,
        v_template.template_version,
        v_template.template_snapshot,
        'pending',
        0,
        COALESCE(v_template.max_attempts, 5),
        now(),
        v_job_purpose,
        v_idempotency_key,
        p_requested_by,
        p_requested_source,
        v_template.template_snapshot -> 'label_config' ->> 'provider_hint',
        v_retry_backoff
    )
    ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
    RETURNING id INTO v_job_id;

    IF v_job_id IS NOT NULL THEN
        v_inserted := TRUE;
    END IF;

    IF v_job_id IS NULL THEN
        SELECT id
        INTO v_job_id
        FROM label_jobs
        WHERE organization_id = v_shipment.organization_id
          AND shipment_id = p_shipment_id
          AND shipment_box_id IS NOT DISTINCT FROM p_shipment_box_id
          AND label_type = lower(p_label_type)
          AND template_id = v_template.template_id
          AND job_purpose = v_job_purpose
        ORDER BY created_at DESC
        LIMIT 1;
    END IF;

    PERFORM log_decision(
        p_organization_id := v_shipment.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job_id,
        p_decision_point := 'request_label_generation',
        p_decision_outcome := CASE WHEN v_inserted THEN 'enqueued' ELSE 'reused' END,
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_build_object(
            'shipment_id', p_shipment_id,
            'shipment_box_id', p_shipment_box_id,
            'label_type', lower(p_label_type),
            'template_id', v_template.template_id,
            'template_version', v_template.template_version,
            'job_purpose', v_job_purpose
        ),
        p_decision_reason := CASE WHEN v_inserted THEN NULL ELSE 'idempotent_reuse' END
    );

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    IS 'Create or return an idempotent label job for a shipment and label type.';

CREATE OR REPLACE FUNCTION complete_label_job(
    p_job_id UUID,
    p_status TEXT,
    p_file_url TEXT,
    p_file_size_bytes INTEGER,
    p_renderer_metadata JSONB DEFAULT NULL,
    p_error_reason TEXT DEFAULT NULL
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_now TIMESTAMPTZ := now();
    v_barcode TEXT;
    v_barcode_format TEXT;
    v_label_id UUID;
    v_label_metadata JSONB;
    v_retry_seconds INTEGER;
    v_retry_length INTEGER;
    v_index INTEGER;
    v_max_delay INTEGER := 3600;
BEGIN
    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    IF lower(p_status) = 'succeeded' THEN
        IF v_job.shipment_box_id IS NOT NULL THEN
            SELECT barcode
            INTO v_barcode
            FROM shipment_boxes
            WHERE id = v_job.shipment_box_id;
        END IF;

        IF v_barcode IS NULL THEN
            SELECT sb.barcode
            INTO v_barcode
            FROM shipment_boxes sb
            WHERE sb.shipment_id = v_job.shipment_id
            ORDER BY sb.box_number
            LIMIT 1;
        END IF;

        v_barcode := COALESCE(
            v_barcode,
            v_job.template_snapshot -> 'label_config' ->> 'fallback_barcode'
        );

        IF v_barcode IS NULL THEN
            RAISE EXCEPTION 'Unable to resolve barcode for label job %', p_job_id;
        END IF;

        v_barcode_format := COALESCE(
            v_job.template_snapshot -> 'label_config' ->> 'barcode_format',
            v_job.template_snapshot -> 'renderer_config' -> 'barcode' ->> 'type',
            'CODE128'
        );

        v_label_id := COALESCE(v_job.label_id, gen_random_uuid());

        v_label_metadata := jsonb_build_object(
            'label_job_id', v_job.id,
            'template', v_job.template_snapshot
        );

        INSERT INTO labels (
            id,
            shipment_id,
            organization_id,
            client_id,
            label_type,
            barcode,
            barcode_format,
            layout_template_id,
            file_url,
            file_size_bytes,
            generated_by,
            generated_at,
            print_count,
            last_printed_at,
            metadata,
            renderer_metadata
        )
        VALUES (
            v_label_id,
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            v_job.label_type,
            v_barcode,
            v_barcode_format,
            v_job.template_id,
            p_file_url,
            COALESCE(p_file_size_bytes, 0),
            v_job.requested_by,
            v_now,
            1,
            v_now,
            v_label_metadata,
            COALESCE(p_renderer_metadata, '{}'::jsonb)
        )
        ON CONFLICT (id, shipment_id) DO UPDATE
        SET file_url = EXCLUDED.file_url,
            file_size_bytes = EXCLUDED.file_size_bytes,
            generated_by = EXCLUDED.generated_by,
            generated_at = EXCLUDED.generated_at,
            last_printed_at = EXCLUDED.last_printed_at,
            print_count = labels.print_count + 1,
            metadata = EXCLUDED.metadata,
            renderer_metadata = EXCLUDED.renderer_metadata;

        UPDATE label_jobs
        SET status = 'succeeded',
            completed_at = v_now,
            lease_expires_at = NULL,
            output_file_url = p_file_url,
            output_file_size_bytes = COALESCE(p_file_size_bytes, 0),
            renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
            error_reason = NULL,
            label_id = v_label_id
        WHERE id = v_job.id;

        INSERT INTO shipment_actions (
            id,
            shipment_id,
            organization_id,
            client_id,
            action_type,
            action_category,
            action_data,
            timestamp,
            created_at,
            performed_by_system
        )
        VALUES (
            gen_random_uuid(),
            v_job.shipment_id,
            v_job.organization_id,
            v_job.client_id,
            'label_generated',
            'operational',
            jsonb_build_object(
                'label_job_id', v_job.id,
                'label_id', v_label_id,
                'attempts', v_job.attempts,
                'template_version', v_job.template_version
            ),
            v_now,
            v_now,
            'label_renderer'
        );

        PERFORM log_decision(
            p_organization_id := v_job.organization_id,
            p_decision_category := 'label_job',
            p_resource_type := 'label_job',
            p_resource_id := v_job.id,
            p_decision_point := 'complete_label_job',
            p_decision_outcome := 'render_succeeded',
            p_performed_by_system := 'label_renderer',
            p_correlation_id := NULL,
            p_decision_inputs := jsonb_build_object(
                'label_id', v_label_id,
                'file_url', p_file_url,
                'file_size_bytes', COALESCE(p_file_size_bytes, 0),
                'attempts', v_job.attempts + 1,
                'template_id', v_job.template_id,
                'template_version', v_job.template_version
            )
        );
    ELSE
        v_retry_length := COALESCE(jsonb_array_length(v_job.retry_state), 0);
        IF v_retry_length >= v_job.attempts AND v_job.attempts > 0 THEN
            v_index := v_job.attempts;
            v_retry_seconds := COALESCE((v_job.retry_state ->> (v_index - 1))::INTEGER, 0);
        ELSE
            v_retry_seconds := 0;
        END IF;
        IF v_retry_seconds <= 0 THEN
            v_retry_seconds := LEAST(v_max_delay, 60 * (2 ^ GREATEST(v_job.attempts - 1, 0)));
        END IF;
        v_retry_seconds := LEAST(v_max_delay, GREATEST(v_retry_seconds, 30));

        IF v_job.attempts >= v_job.max_attempts THEN
            UPDATE label_jobs
            SET status = 'failed',
                completed_at = v_now,
                lease_expires_at = NULL,
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = COALESCE(p_error_reason, 'max_attempts_exceeded')
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_failed',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := COALESCE(p_error_reason, 'max_attempts_exceeded')
            );
        ELSE
            UPDATE label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = p_error_reason
            WHERE id = v_job.id;

            PERFORM log_decision(
                p_organization_id := v_job.organization_id,
                p_decision_category := 'label_job',
                p_resource_type := 'label_job',
                p_resource_id := v_job.id,
                p_decision_point := 'complete_label_job',
                p_decision_outcome := 'render_retry_scheduled',
                p_performed_by_system := 'label_renderer',
                p_correlation_id := NULL,
                p_decision_inputs := jsonb_build_object(
                    'next_attempt_in_seconds', v_retry_seconds,
                    'attempts', v_job.attempts,
                    'max_attempts', v_job.max_attempts,
                    'template_id', v_job.template_id,
                    'template_version', v_job.template_version
                ),
                p_decision_reason := p_error_reason
            );
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, updating label records and scheduling retries.';

-------------------------------------------------------------------------------
-- Domain events worker hardening (organization guard + fallback resolution)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION run_domain_events_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_event RECORD;
    v_policy JSONB;
    v_template UUID;
    v_context_patch JSONB;
    v_workflow_context JSONB;
    v_run UUID;
    v_org UUID;
    v_resolved_org UUID;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('domain_events_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('domain_events_worker');

    FOR v_event IN
        SELECT *
        FROM domain_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            v_org := v_event.organization_id;

            IF v_org IS NULL OR NOT EXISTS (SELECT 1 FROM organizations WHERE id = v_org) THEN
                v_resolved_org := NULL;

                IF v_event.resource_type IS NOT NULL AND v_event.resource_id IS NOT NULL THEN
                    BEGIN
                        v_resolved_org := resolve_organization_id_strict(v_event.resource_type, v_event.resource_id);
                    EXCEPTION
                        WHEN others THEN
                            v_resolved_org := NULL;
                    END;
                END IF;

                IF v_resolved_org IS NULL THEN
                    UPDATE domain_events
                    SET status = 'failed',
                        error_reason = 'organization_not_found',
                        processed_at = now(),
                        updated_at = now()
                    WHERE id = v_event.id;

                    CONTINUE;
                END IF;

                UPDATE domain_events
                SET organization_id = v_resolved_org,
                    updated_at = now()
                WHERE id = v_event.id;

                v_org := v_resolved_org;
                v_event.organization_id := v_resolved_org;
            END IF;

            v_policy := resolve_domain_event_policy(v_org, v_event.event_type);
            v_template := NULLIF(v_policy->>'workflow_template_id', '')::UUID;
            v_context_patch := COALESCE(v_policy->'context_patch', '{}'::jsonb);

            IF v_template IS NULL THEN
                UPDATE domain_events
                SET status = 'skipped',
                    error_reason = 'policy_not_found',
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                PERFORM log_decision(
                    p_organization_id := v_org,
                    p_decision_category := 'domain_event',
                    p_resource_type := 'domain_event',
                    p_resource_id := v_event.id,
                    p_decision_point := 'dispatch',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'domain_events_worker',
                    p_correlation_id := v_event.correlation_id,
                    p_decision_inputs := jsonb_build_object(
                        'event_type', v_event.event_type,
                        'resource_type', v_event.resource_type,
                        'resource_id', v_event.resource_id,
                        'reason', 'policy_not_found'
                    )
                );

                CONTINUE;
            END IF;

            v_workflow_context := jsonb_strip_nulls(
                jsonb_build_object(
                    'domain_event_id', v_event.id,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id,
                    'payload', v_event.payload,
                    'trigger_source', 'domain_event',
                    'correlation_id', v_event.correlation_id
                )
            ) || jsonb_strip_nulls(COALESCE(v_context_patch, '{}'::jsonb));

            v_run := start_workflow_run(v_template, v_workflow_context);

            UPDATE domain_events
            SET status = 'processing',
                workflow_run_id = v_run,
                processed_at = now(),
                updated_at = now()
            WHERE id = v_event.id;

            PERFORM log_decision(
                p_organization_id := v_org,
                p_decision_category := 'domain_event',
                p_resource_type := 'domain_event',
                p_resource_id := v_event.id,
                p_decision_point := 'dispatch',
                p_decision_outcome := 'enqueued',
                p_performed_by_system := 'domain_events_worker',
                p_correlation_id := v_event.correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'workflow_run_id', v_run,
                    'workflow_template_id', v_template,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id
                ))
            );

            v_processed := v_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE domain_events
                SET status = 'failed',
                    error_reason = SQLERRM,
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                IF v_org IS NOT NULL THEN
                    PERFORM log_decision(
                        p_organization_id := v_org,
                        p_decision_category := 'domain_event',
                        p_resource_type := 'domain_event',
                        p_resource_id := v_event.id,
                        p_decision_point := 'dispatch',
                        p_decision_outcome := 'error',
                        p_performed_by_system := 'domain_events_worker',
                        p_correlation_id := v_event.correlation_id,
                        p_decision_reason := SQLERRM,
                        p_decision_inputs := jsonb_build_object(
                            'event_type', v_event.event_type,
                            'resource_type', v_event.resource_type,
                            'resource_id', v_event.resource_id
                        )
                    );
                END IF;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_processed);
    PERFORM update_cron_config('domain_events_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMIT;
