-- Migration: Label jobs workflow context linkage
-- Purpose: Link label job inserts to workflow steps, enforce workflow context, and add wrapper support.

BEGIN;

SET search_path TO public, extensions, pg_temp;

ALTER TABLE public.label_jobs
  ADD COLUMN IF NOT EXISTS workflow_run_step_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'label_jobs_workflow_run_step_fk'
      AND conrelid = 'public.label_jobs'::regclass
  ) THEN
    ALTER TABLE public.label_jobs
      ADD CONSTRAINT label_jobs_workflow_run_step_fk
      FOREIGN KEY (workflow_run_step_id)
      REFERENCES public.workflow_run_steps(id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_label_jobs_workflow_run_step_id
  ON public.label_jobs (workflow_run_step_id)
  WHERE workflow_run_step_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.label_jobs_fill_step_from_context()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_step TEXT;
  v_step_id UUID;
BEGIN
  IF NEW.workflow_run_step_id IS NULL THEN
    v_step := current_setting('app.workflow_run_step_id', TRUE);
    IF v_step IS NULL OR btrim(v_step) = '' THEN
      v_step := current_setting('masarx.workflow_run_step_id', TRUE);
    END IF;

    IF v_step IS NOT NULL AND btrim(v_step) <> '' THEN
      BEGIN
        v_step_id := v_step::UUID;
      EXCEPTION
        WHEN others THEN
          v_step_id := NULL;
      END;

      IF v_step_id IS NOT NULL THEN
        NEW.workflow_run_step_id := v_step_id;
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_jobs_fill_step_from_context ON public.label_jobs;
CREATE TRIGGER trg_label_jobs_fill_step_from_context
  BEFORE INSERT ON public.label_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.label_jobs_fill_step_from_context();

CREATE OR REPLACE FUNCTION public.label_jobs_forbid_step_change_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, pg_temp
AS $$
BEGIN
  IF OLD.workflow_run_step_id IS NOT NULL
     AND NEW.workflow_run_step_id IS DISTINCT FROM OLD.workflow_run_step_id THEN
    RAISE EXCEPTION 'label_jobs update rejected: workflow_run_step_id is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_label_jobs_forbid_step_change_v1 ON public.label_jobs;
CREATE TRIGGER trg_label_jobs_forbid_step_change_v1
  BEFORE UPDATE OF workflow_run_step_id ON public.label_jobs
  FOR EACH ROW
  EXECUTE FUNCTION public.label_jobs_forbid_step_change_v1();

INSERT INTO public.workflow_guardrails (
  resource_table,
  enforcement_mode,
  enforce_on,
  required_context_keys,
  context_match,
  allow_roles,
  notes
)
VALUES (
  'label_jobs',
  'enforce',
  ARRAY['INSERT']::TEXT[],
  ARRAY['workflow_run_id', 'workflow_run_step_id']::TEXT[],
  jsonb_build_object('workflow_run_step_id', 'workflow_run_step_id'),
  ARRAY[]::TEXT[],
  'Guard label_jobs inserts to require workflow context and step linkage.'
)
ON CONFLICT (resource_table) DO UPDATE
SET enforcement_mode = EXCLUDED.enforcement_mode,
    enforce_on = EXCLUDED.enforce_on,
    required_context_keys = EXCLUDED.required_context_keys,
    context_match = EXCLUDED.context_match,
    allow_roles = EXCLUDED.allow_roles,
    notes = EXCLUDED.notes,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.ensure_label_job_workflow_context(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  workflow_run_id UUID,
  workflow_run_step_id UUID,
  created_wrapper BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_run_text TEXT;
  v_step_text TEXT;
  v_run_id UUID;
  v_step_id UUID;
  v_policy_ctx JSONB;
  v_defaults JSONB;
  v_template_id UUID;
  v_template_version INT;
  v_template_step workflow_template_steps%ROWTYPE;
  v_now TIMESTAMPTZ := now();
BEGIN
  v_run_text := current_setting('app.workflow_run_id', true);
  v_step_text := current_setting('app.workflow_run_step_id', true);

  IF v_step_text IS NULL OR btrim(v_step_text) = '' THEN
    v_step_text := current_setting('masarx.workflow_run_step_id', true);
  END IF;

  BEGIN
    v_run_id := NULLIF(v_run_text, '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_run_id := NULL;
  END;

  BEGIN
    v_step_id := NULLIF(v_step_text, '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_step_id := NULL;
  END;

  IF v_run_id IS NOT NULL AND v_step_id IS NOT NULL THEN
    workflow_run_id := v_run_id;
    workflow_run_step_id := v_step_id;
    created_wrapper := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', p_context->>'organization_id',
    'client_id', p_context->>'client_id',
    'sender_id', p_context->>'sender_id',
    'webhook_source_id', p_context->>'webhook_source_id'
  ));

  SELECT value
  INTO v_defaults
  FROM public.resolve_settings_row_from_context('workflow_defaults', v_policy_ctx)
  LIMIT 1;

  BEGIN
    v_template_id := NULLIF(v_defaults->>'legacy_label_job_template_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_template_id := NULL;
  END;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ensure_label_job_workflow_context: legacy label job template missing';
  END IF;

  SELECT id, version
  INTO v_template_id, v_template_version
  FROM public.workflow_templates
  WHERE id = v_template_id
    AND status = 'active'
  ORDER BY updated_at DESC
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ensure_label_job_workflow_context: legacy label job template missing';
  END IF;

  SELECT *
  INTO v_template_step
  FROM public.workflow_template_steps
  WHERE workflow_template_id = v_template_id
    AND enabled = TRUE
  ORDER BY sequence_order, updated_at DESC
  LIMIT 1;

  IF v_template_step.id IS NULL THEN
    RAISE EXCEPTION 'ensure_label_job_workflow_context: legacy label job step missing';
  END IF;

  v_run_id := gen_random_uuid();
  v_step_id := gen_random_uuid();

  PERFORM set_config('app.workflow_run_id', v_run_id::text, true);
  PERFORM set_config('app.workflow_run_step_id', v_step_id::text, true);

  INSERT INTO public.workflow_runs (
    id,
    workflow_template_id,
    workflow_template_version,
    entry_point,
    workflow_status,
    current_step_id,
    context,
    metadata,
    created_at,
    started_at,
    updated_at,
    completed_at
  )
  VALUES (
    v_run_id,
    v_template_id,
    COALESCE(v_template_version, 1),
    'label_job_wrapper',
    'completed',
    NULL,
    jsonb_strip_nulls(COALESCE(p_context, '{}'::jsonb) || jsonb_build_object(
      'wrapper', 'label_job',
      'source', 'ensure_label_job_workflow_context'
    )),
    jsonb_build_object('source', 'ensure_label_job_workflow_context'),
    v_now,
    v_now,
    v_now,
    v_now
  );

  INSERT INTO public.workflow_run_steps (
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
    operation_started_at,
    operation_completed_at,
    duration_ms,
    retry_attempt,
    enqueued_at,
    created_at,
    updated_at
  )
  VALUES (
    v_step_id,
    v_run_id,
    v_template_step.id,
    COALESCE(v_template_step.sequence_order, 1),
    'completed',
    v_template_step.operation_name,
    COALESCE(NULLIF(v_template_step.metadata->>'max_retries', '')::INT, 1),
    jsonb_strip_nulls(COALESCE(v_template_step.metadata, '{}'::jsonb) || jsonb_build_object(
      'wrapper', 'label_job'
    )),
    COALESCE(NULLIF(v_template_step.handler_key, ''), 'label_job'),
    COALESCE(NULLIF(v_template_step.handler_version, ''), 'v1'),
    v_now,
    v_now,
    1,
    0,
    v_now,
    v_now,
    v_now
  );

  workflow_run_id := v_run_id;
  workflow_run_step_id := v_step_id;
  created_wrapper := TRUE;
  RETURN NEXT;
END;
$$;

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
SET search_path TO public, extensions, pg_temp
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
    v_context JSONB;
    v_workflow_run_id UUID;
    v_workflow_run_step_id UUID;
    v_created_wrapper BOOLEAN := FALSE;
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

    v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_shipment.organization_id,
        'client_id', v_shipment.client_id,
        'sender_id', v_shipment.sender_id,
        'shipment_id', p_shipment_id,
        'shipment_box_id', p_shipment_box_id,
        'label_type', lower(p_label_type),
        'job_purpose', v_job_purpose,
        'requested_source', p_requested_source
    ));

    SELECT workflow_run_id, workflow_run_step_id, created_wrapper
    INTO v_workflow_run_id, v_workflow_run_step_id, v_created_wrapper
    FROM public.ensure_label_job_workflow_context(v_context)
    LIMIT 1;

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
        retry_state,
        workflow_run_step_id
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
        v_retry_backoff,
        v_workflow_run_step_id
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

        IF v_job_id IS NOT NULL THEN
          UPDATE label_jobs
          SET workflow_run_step_id = COALESCE(workflow_run_step_id, v_workflow_run_step_id),
              updated_at = now()
          WHERE id = v_job_id
            AND workflow_run_step_id IS NULL;
        END IF;
    END IF;

    IF v_created_wrapper AND v_job_id IS NOT NULL THEN
      UPDATE workflow_run_steps
      SET operation_result = jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job_id,
            'label_type', lower(p_label_type),
            'job_purpose', v_job_purpose
          )),
          updated_at = now()
      WHERE id = v_workflow_run_step_id;

      UPDATE workflow_runs
      SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'label_job_id', v_job_id,
            'label_job_status', 'pending'
          )),
          updated_at = now()
      WHERE id = v_workflow_run_id;
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

COMMENT ON FUNCTION public.request_label_generation(UUID, TEXT, UUID, TEXT, UUID, TEXT)
    IS 'Create or return an idempotent label job for a shipment and label type.';

CREATE OR REPLACE FUNCTION public.request_label_reprint(
    p_label_id UUID,
    p_actor_id UUID DEFAULT NULL,
    p_requested_source TEXT DEFAULT 'reprint'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_label RECORD;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
    v_context JSONB;
    v_workflow_run_id UUID;
    v_workflow_run_step_id UUID;
    v_created_wrapper BOOLEAN := FALSE;
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

    IF current_user <> 'service_role' THEN
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

    v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_label.organization_id,
        'client_id', v_label.client_id,
        'sender_id', v_label.sender_id,
        'shipment_id', v_label.shipment_id,
        'shipment_box_id', v_label.matched_box_id,
        'label_id', p_label_id,
        'label_type', v_label.label_type,
        'job_purpose', 'reprint',
        'requested_source', p_requested_source
    ));

    SELECT workflow_run_id, workflow_run_step_id, created_wrapper
    INTO v_workflow_run_id, v_workflow_run_step_id, v_created_wrapper
    FROM public.ensure_label_job_workflow_context(v_context)
    LIMIT 1;

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
        retry_state,
        workflow_run_step_id
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
        COALESCE(v_retry, '[]'::jsonb),
        v_workflow_run_step_id
    )
    RETURNING id INTO v_job_id;

    IF v_created_wrapper AND v_job_id IS NOT NULL THEN
      UPDATE workflow_run_steps
      SET operation_result = jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job_id,
            'label_type', v_label.label_type,
            'job_purpose', 'reprint'
          )),
          updated_at = now()
      WHERE id = v_workflow_run_step_id;

      UPDATE workflow_runs
      SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'label_job_id', v_job_id,
            'label_job_status', 'pending'
          )),
          updated_at = now()
      WHERE id = v_workflow_run_id;
    END IF;

    RETURN v_job_id;
END;
$$;

COMMENT ON FUNCTION public.request_label_reprint(UUID, UUID, TEXT)
    IS 'Queue a reprint job using the original template snapshot stored on the label.';

COMMIT;
