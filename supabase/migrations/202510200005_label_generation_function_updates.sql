-- Recovered from supabase_migrations.schema_migrations on 2025-10-21T09:46:35Z
-- Version: 202510200005
-- Name: label_generation_function_updates

-- Migration 202510200005: Update label job functions with relaxed role checks
-- Purpose: Align previously deployed functions with new security guard clauses allowing postgres/supabase_admin contexts.

SET search_path = public;

-- Recreate request_label_generation with updated role whitelist
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

COMMENT ON FUNCTION request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    IS 'Create or return an idempotent label job for a shipment and label type.';

-- Recreate compose_label_payload with updated role whitelist
CREATE OR REPLACE FUNCTION compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_payload JSONB;
BEGIN
    SELECT *
    INTO v_job
    FROM label_jobs
    WHERE id = p_job_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label job % not found', p_job_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
            RAISE EXCEPTION 'Access denied for label job %', p_job_id;
        END IF;
    END IF;

    SELECT to_jsonb(payload)
    INTO v_payload
    FROM shipment_label_payload_v payload
    WHERE payload.shipment_id = v_job.shipment_id
      AND (
            v_job.shipment_box_id IS NULL
            OR payload.shipment_box_id = v_job.shipment_box_id
          )
    ORDER BY payload.box_number NULLS FIRST
    LIMIT 1;

    RETURN jsonb_build_object(
        'job', jsonb_build_object(
            'id', v_job.id,
            'organization_id', v_job.organization_id,
            'client_id', v_job.client_id,
            'shipment_id', v_job.shipment_id,
            'shipment_box_id', v_job.shipment_box_id,
            'label_type', v_job.label_type,
            'attempts', v_job.attempts,
            'max_attempts', v_job.max_attempts,
            'template', v_job.template_snapshot,
            'renderer_hint', v_job.renderer_hint,
            'retry_state', v_job.retry_state
        ),
        'payload', COALESCE(v_payload, '{}'::jsonb)
    );
END;
$$;

COMMENT ON FUNCTION compose_label_payload(UUID)
    IS 'Return canonical payload + template snapshot for a label job.';

-- Recreate lease_label_job with optional job targeting and role whitelist
CREATE OR REPLACE FUNCTION lease_label_job(
    p_organization_id UUID DEFAULT NULL,
    p_lease_seconds INTEGER DEFAULT 300,
    p_job_id UUID DEFAULT NULL
)
RETURNS label_jobs
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_job label_jobs%ROWTYPE;
    v_lease_interval INTERVAL := make_interval(secs => GREATEST(COALESCE(p_lease_seconds, 300), 60));
BEGIN
    IF p_job_id IS NOT NULL THEN
        SELECT *
        INTO v_job
        FROM label_jobs
        WHERE id = p_job_id
          AND status = 'pending'
        FOR UPDATE;

        IF NOT FOUND THEN
            RETURN NULL;
        END IF;

        IF p_organization_id IS NOT NULL
           AND v_job.organization_id <> p_organization_id THEN
            RAISE EXCEPTION 'Label job % does not belong to organization %', p_job_id, p_organization_id;
        END IF;

        UPDATE label_jobs
        SET status = 'in_progress',
            attempts = label_jobs.attempts + 1,
            last_attempt_at = now(),
            lease_expires_at = now() + v_lease_interval
        WHERE id = v_job.id
        RETURNING * INTO v_job;

        RETURN v_job;
    END IF;

    WITH candidate AS (
        SELECT id
        FROM label_jobs
        WHERE status = 'pending'
          AND scheduled_at <= now()
          AND attempts < max_attempts
          AND (p_organization_id IS NULL OR organization_id = p_organization_id)
          AND p_job_id IS NULL
        ORDER BY scheduled_at, created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
    )
    UPDATE label_jobs lj
    SET status = 'in_progress',
        attempts = lj.attempts + 1,
        last_attempt_at = now(),
        lease_expires_at = now() + v_lease_interval
    FROM candidate
    WHERE lj.id = candidate.id
    RETURNING lj.*
    INTO v_job;

    RETURN v_job;
END;
$$;

COMMENT ON FUNCTION lease_label_job(UUID, INTEGER, UUID)
    IS 'Lease the next pending label job, marking it in progress and returning the row.';

-- Recreate complete_label_job with updated role whitelist
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
        ELSE
            UPDATE label_jobs
            SET status = 'pending',
                lease_expires_at = NULL,
                scheduled_at = v_now + make_interval(secs => v_retry_seconds),
                renderer_metadata = COALESCE(p_renderer_metadata, '{}'::jsonb),
                error_reason = p_error_reason
            WHERE id = v_job.id;
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT)
    IS 'Mark a label job as succeeded or failed, updating label records and scheduling retries.';

-- Recreate request_label_reprint with updated role whitelist
CREATE OR REPLACE FUNCTION request_label_reprint(
    p_label_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_label RECORD;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
BEGIN
    SELECT
        l.*,
        s.organization_id,
        s.client_id,
        s.sender_id,
        sb.id AS matched_box_id
    INTO v_label
    FROM labels l
    JOIN shipments s ON s.id = l.shipment_id
    LEFT JOIN shipment_boxes sb ON sb.barcode = l.barcode
    WHERE l.id = p_label_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_label.organization_id THEN
            RAISE EXCEPTION 'Access denied for label %', p_label_id;
        END IF;
    END IF;

    v_template_snapshot := COALESCE(v_label.metadata -> 'template', '{}'::jsonb);

    IF jsonb_typeof(v_template_snapshot) IS DISTINCT FROM 'object'
        OR v_template_snapshot = '{}'::jsonb THEN
        SELECT
            rt.template_snapshot,
            rt.template_version,
            rt.template_id,
            rt.max_attempts,
            rt.retry_backoff
        INTO v_template_snapshot,
             v_template_version,
             v_template_id,
             v_max_attempts,
             v_retry
        FROM resolve_label_template(
            v_label.organization_id,
            v_label.client_id,
            v_label.sender_id,
            v_label.label_type
        ) AS rt
        LIMIT 1;
    ELSE
        v_template_version := COALESCE((v_template_snapshot ->> 'template_version')::INTEGER, 1);
        v_template_id := COALESCE(v_label.layout_template_id, (v_template_snapshot ->> 'template_id')::UUID);
        v_retry := COALESCE(v_template_snapshot -> 'label_config' -> 'retry_backoff_seconds', '[]'::jsonb);
        v_max_attempts := COALESCE((v_template_snapshot -> 'label_config' ->> 'max_attempts')::INTEGER, 5);
    END IF;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'Template reference missing for label %', p_label_id;
    END IF;

    INSERT INTO label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_id,
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
        v_label.organization_id,
        v_label.client_id,
        v_label.shipment_id,
        v_label.matched_box_id,
        p_label_id,
        v_label.label_type,
        v_template_id,
        v_template_version,
        v_template_snapshot,
        'pending',
        0,
        COALESCE(v_max_attempts, 5),
        now(),
        'reprint',
        gen_random_uuid()::text,
        p_actor_id,
        p_requested_source,
        v_template_snapshot -> 'label_config' ->> 'provider_hint',
        COALESCE(v_retry, '[]'::jsonb)
    )
    RETURNING id INTO v_job_id;

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION request_label_reprint(UUID, UUID, TEXT)
    IS 'Queue a reprint job using the original template snapshot stored on the label.';
