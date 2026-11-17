-- Migration: Warnings cleanup and minor robustness fixes
-- Purpose: Remove unused variables/params and make small behavior-safe improvements
-- Date: 2025-11-15 14:00

BEGIN;

SET search_path = public;

-- 1) start_workflow_run: remove unused v_handler_key variable
CREATE OR REPLACE FUNCTION public.start_workflow_run(
    p_workflow_template_id UUID,
    p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_template workflow_templates%ROWTYPE;
    v_run_id UUID;
    v_now TIMESTAMPTZ := now();
BEGIN
    SELECT *
    INTO v_template
    FROM workflow_templates
    WHERE id = p_workflow_template_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'start_workflow_run: template % not found', p_workflow_template_id;
    END IF;

    IF v_template.status <> 'active' THEN
        RAISE EXCEPTION 'start_workflow_run: template % is not active', p_workflow_template_id;
    END IF;

    v_run_id := gen_random_uuid();

    INSERT INTO workflow_runs (
        id,
        workflow_template_id,
        workflow_template_version,
        entry_point,
        workflow_status,
        context,
        metadata,
        created_at,
        updated_at
    )
    VALUES (
        v_run_id,
        v_template.id,
        v_template.version,
        'webhook',
        'pending',
        COALESCE(p_context, '{}'::jsonb),
        jsonb_build_object('template_notes', v_template.notes),
        v_now,
        v_now
    );

    INSERT INTO workflow_run_steps (
        id,
        workflow_run_id,
        workflow_template_step_id,
        sequence_order,
        step_status,
        operation_name,
        max_retries,
        metadata,
        handler_key,
        handler_version,
        enqueued_at,
        created_at,
        updated_at
    )
    SELECT
        gen_random_uuid(),
        v_run_id,
        wts.id,
        wts.sequence_order,
        'pending',
        wts.operation_name,
        COALESCE(
            NULLIF(wts.metadata->>'max_retries', '')::INT,
            3
        ),
        COALESCE(wts.metadata, '{}'::jsonb),
        COALESCE(
            NULLIF(wts.handler_key, ''),
            CASE
                WHEN wts.operation_settings_category = 'operation_template' THEN 'outbound_http'
                ELSE NULL
            END
        ),
        COALESCE(NULLIF(wts.handler_version, ''), 'v1'),
        v_now,
        v_now,
        v_now
    FROM workflow_template_steps wts
    WHERE wts.workflow_template_id = v_template.id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;

    RETURN v_run_id;
END;
$$;

COMMENT ON FUNCTION public.start_workflow_run(UUID, JSONB)
    IS 'Create workflow run + step records for active template; returns workflow_run_id.';

-- 2) record_workflow_decision: consume p_step_id by injecting into decision_inputs payload
CREATE OR REPLACE FUNCTION public.record_workflow_decision(
    p_workflow_run_id UUID,
    p_step_id UUID,
    p_payload JSONB
)
RETURNS UUID
LANGUAGE plpgsql
AS $$
DECLARE
    v_run RECORD;
    v_org UUID;
    v_decision_id UUID;
    v_inputs JSONB;
BEGIN
    SELECT wr.workflow_template_id, wt.scope_id
    INTO v_run
    FROM workflow_runs wr
    JOIN workflow_templates wt ON wt.id = wr.workflow_template_id
    WHERE wr.id = p_workflow_run_id;

    IF v_run.scope_id IS NOT NULL THEN
        v_org := v_run.scope_id;
    ELSE
        v_org := (SELECT organization_id FROM clients ORDER BY created_at ASC LIMIT 1);
    END IF;

    IF v_org IS NULL THEN
        RAISE EXCEPTION 'Unable to resolve organization for workflow decision (workflow_run_id=%)', p_workflow_run_id;
    END IF;

    v_inputs := COALESCE(p_payload, '{}'::jsonb) || jsonb_build_object('workflow_run_step_id', p_step_id);

    v_decision_id := log_decision(
        p_organization_id := v_org,
        p_decision_category := 'workflow',
        p_resource_type := 'workflow_run',
        p_resource_id := p_workflow_run_id,
        p_decision_point := 'step_decision',
        p_decision_outcome := COALESCE(v_inputs->>'status', 'unknown'),
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := v_inputs,
        p_decision_reason := 'Workflow decision recorded'
    );

    RETURN v_decision_id;
END;
$$;

COMMENT ON FUNCTION public.record_workflow_decision(UUID, UUID, JSONB)
    IS 'Write workflow decisions to decision_log via log_decision, returning decision_log.id.';

-- 3) create_request_context: use p_worker_name to copy batch_size from cron_config
CREATE OR REPLACE FUNCTION public.create_request_context(
    p_worker_name TEXT,
    p_entry_point TEXT DEFAULT 'worker'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID := gen_random_uuid();
    v_batch_size INT;
BEGIN
    SELECT batch_size
    INTO v_batch_size
    FROM cron_config
    WHERE worker_name = p_worker_name;

    INSERT INTO request_contexts (
        id,
        entry_point,
        primary_entity_type,
        primary_entity_id,
        batch_size,
        started_at,
        created_at,
        error_occurred
    ) VALUES (
        v_id,
        p_entry_point,
        'worker',
        NULL,
        v_batch_size,
        now(),
        now(),
        FALSE
    );

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.create_request_context(TEXT, TEXT)
    IS 'Create a request_context row for worker execution; seeds batch_size from cron_config when available.';

-- 4) archive_old_partitions: remove unused v_sql and reference v_cutoff_date for notice
CREATE OR REPLACE FUNCTION public.archive_old_partitions()
RETURNS TABLE (
    table_name TEXT,
    partition_name TEXT,
    row_count BIGINT,
    detached BOOLEAN,
    archived_to TEXT
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_config RECORD;
    v_partition_record RECORD;
    v_cutoff_date TIMESTAMPTZ;
    v_archive_schema TEXT := 'archive';
    v_row_count BIGINT;
BEGIN
    FOR v_config IN
        SELECT
            pc.table_name,
            pc.partition_interval,
            COALESCE(pc.retention_months, 6) AS retention_months
        FROM partitioning_config pc
        WHERE pc.partition_strategy IN ('RANGE', 'HASH+RANGE')
          AND pc.retention_months IS NOT NULL
        ORDER BY pc.table_name
    LOOP
        v_cutoff_date := now() - (v_config.retention_months || ' months')::interval;
        RAISE NOTICE 'archive_old_partitions: cutoff for % is %', v_config.table_name, v_cutoff_date;

        FOR v_partition_record IN
            SELECT
                c.relname AS part_name,
                pg_get_expr(c.relpartbound, c.oid) AS part_expr
            FROM pg_class c
            JOIN pg_inherits i ON i.inhrelid = c.oid
            JOIN pg_class p ON p.oid = i.inhparent
            WHERE p.relname LIKE v_config.table_name || '_p%'
              AND c.relkind = 'r'
        LOOP
            EXECUTE format('SELECT COUNT(*) FROM %I', v_partition_record.part_name) INTO v_row_count;

            table_name := v_config.table_name;
            partition_name := v_partition_record.part_name;
            row_count := v_row_count;
            detached := false;
            archived_to := v_archive_schema || '.' || v_partition_record.part_name;
            RETURN NEXT;
        END LOOP;
    END LOOP;

    RETURN;
END;
$$;

COMMENT ON FUNCTION public.archive_old_partitions IS 'Plan-only partition archive listing; emits cutoff via NOTICE and returns candidate rows.';

-- 5) request_label_generation: remove unused v_box by validating with PERFORM
CREATE OR REPLACE FUNCTION public.request_label_generation(
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
    v_template RECORD;
    v_job_id UUID;
    v_idempotency_key TEXT;
    v_retry_backoff JSONB;
    v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
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

    IF current_user <> 'service_role' THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_shipment.organization_id THEN
            RAISE EXCEPTION 'Access denied for shipment %', p_shipment_id;
        END IF;
    END IF;

    IF p_shipment_box_id IS NOT NULL THEN
        PERFORM 1
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
    RETURNING id
    INTO v_job_id;

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

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    IS 'Create or return an idempotent label job for a shipment and label type.';

COMMIT;

