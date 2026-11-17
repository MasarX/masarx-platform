-- Migration: Label request function access relaxation for platform/system roles
-- Purpose: Permit request_label_generation for service_role, postgres, and db owners; enforce org check otherwise
-- Date: 2025-11-15 14:05

BEGIN;

SET search_path = public;

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
    v_is_platform BOOLEAN := (
        current_user = 'service_role' OR
        current_user = 'postgres' OR
        pg_has_role(current_user, 'pg_database_owner', 'member')
    );
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

    IF NOT v_is_platform THEN
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
    IS 'Create or return an idempotent label job for a shipment and label type (platform roles bypass org check).';

COMMIT;

