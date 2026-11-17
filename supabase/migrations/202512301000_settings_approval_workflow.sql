-- Migration: Settings approvals via workflow engine
-- Purpose:
--   - Replace legacy settings_approval_queue usage with workflow-engine approvals.
--   - Generalize manual_review_tasks to support non-client-scoped approvals.
--   - Add a blocking manual_review_wait handler + settings_apply handler.
-- Date: 2025-12-30

BEGIN;

SELECT pg_advisory_lock(hashtext('202512301000_settings_approval_workflow'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;

-- =============================================================================
-- 1) Generalize manual_review_tasks (allow non-client tasks + structured outcome)
-- =============================================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'manual_review_tasks'
      AND column_name = 'client_id'
      AND is_nullable = 'NO'
  ) THEN
    ALTER TABLE public.manual_review_tasks
      ALTER COLUMN client_id DROP NOT NULL;
  END IF;
END$$;

-- =============================================================================
-- 8) RPC: request a settings change (creates unapproved settings_version + enqueues domain event)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.request_settings_change_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_change_reason TEXT DEFAULT NULL,
  p_effective_from TIMESTAMPTZ DEFAULT now()
)
RETURNS TABLE (
  settings_version_id UUID,
  domain_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_scope_type TEXT := lower(COALESCE(NULLIF(p_scope_type, ''), 'global'));
  v_scope_id UUID := p_scope_id;
  v_scope_hash UUID := COALESCE(v_scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
  v_next_version INT;
  v_schema_version INT;
  v_org_id UUID;
  v_client_id UUID;
  v_sender_id UUID;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires tenant/platform write scope';
  END IF;

  IF p_category IS NULL OR btrim(p_category) = '' THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires category';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'request_settings_change_v1 requires value';
  END IF;

  IF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type IN ('global', 'resource') AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'request_settings_change_v1 scope_type=% requires platform user', v_scope_type
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'global' THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'global scope must not include scope_id';
    END IF;
    v_org_id := public.current_user_org_id();
  ELSIF v_scope_type = 'tenant' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'tenant scope requires scope_id';
    END IF;
    v_org_id := v_scope_id;
  ELSIF v_scope_type = 'client' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'client scope requires scope_id';
    END IF;
    v_client_id := v_scope_id;
    SELECT c.organization_id INTO v_org_id FROM public.clients c WHERE c.id = v_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'sender scope requires scope_id';
    END IF;
    v_sender_id := v_scope_id;
    SELECT c.organization_id, s.client_id
      INTO v_org_id, v_client_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_scope_id;
  ELSIF v_scope_type = 'source' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'source scope requires scope_id';
    END IF;
    SELECT ws.organization_id, ws.sender_id
      INTO v_org_id, v_sender_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_scope_id;
    IF v_sender_id IS NOT NULL THEN
      SELECT s.client_id INTO v_client_id FROM public.senders s WHERE s.id = v_sender_id;
    END IF;
  ELSIF v_scope_type = 'resource' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'resource scope requires scope_id';
    END IF;
    v_org_id := public.current_user_org_id();
  ELSE
    RAISE EXCEPTION 'Unsupported scope_type %', p_scope_type USING ERRCODE = '23514';
  END IF;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'request_settings_change_v1 could not resolve organization_id for scope %/%', v_scope_type, v_scope_id;
  END IF;

  IF NOT public.is_platform_user() AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'request_settings_change_v1 cannot target another organization'
      USING ERRCODE = '42501';
  END IF;

  SELECT sr.version INTO v_schema_version
    FROM public.schema_registry sr
   WHERE sr.category = p_category
     AND sr.is_active = TRUE
   ORDER BY sr.version DESC
   LIMIT 1;

  IF v_schema_version IS NULL THEN
    RAISE EXCEPTION 'schema_registry missing active entry for category=%', p_category;
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext(format('settings_versions:%s:%s:%s', p_category, v_scope_type, v_scope_hash::text)));

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions sv
   WHERE sv.category = p_category
     AND sv.scope_type = v_scope_type
     AND sv.scope_hash = v_scope_hash;

  settings_version_id := gen_random_uuid();

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    requested_by,
    approved_by,
    approved_at,
    effective_from,
    effective_until
  ) VALUES (
    settings_version_id,
    p_category,
    v_scope_type,
    v_scope_id,
    v_scope_hash,
    v_next_version,
    p_value,
    v_schema_version,
    COALESCE(p_change_reason, 'requested via request_settings_change_v1'),
    v_user_id,
    NULL,
    NULL,
    COALESCE(p_effective_from, now()),
    NULL
  );

  domain_event_id := public.enqueue_domain_event(
    p_organization_id := v_org_id,
    p_event_type := 'settings_change.requested',
    p_resource_type := 'settings_version',
    p_resource_id := settings_version_id,
    p_payload := jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'settings_version_id', settings_version_id,
      'category', p_category,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'reason', p_change_reason
    )),
    p_correlation_id := NULL
  );

  PERFORM public.log_decision(
      p_organization_id := v_org_id,
      p_decision_category := 'settings',
      p_resource_type := 'settings_version',
      p_resource_id := settings_version_id,
      p_decision_point := 'request',
      p_decision_outcome := 'enqueued',
      p_performed_by_system := 'request_settings_change_v1',
      p_correlation_id := domain_event_id,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'category', p_category,
        'scope_type', v_scope_type,
        'scope_id', v_scope_id,
        'workflow_event_type', 'settings_change.requested'
      )),
      p_decision_reason := p_change_reason
  );

  RETURN NEXT;
END;
$$;

REVOKE ALL ON FUNCTION public.request_settings_change_v1(TEXT, TEXT, UUID, JSONB, TEXT, TIMESTAMPTZ) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.request_settings_change_v1(TEXT, TEXT, UUID, JSONB, TEXT, TIMESTAMPTZ) TO authenticated, service_role;

-- =============================================================================
-- 9) domain_event_policy: map settings_change.requested -> settings_change_approval_v1 (global default)
-- =============================================================================

DO $$
DECLARE
  v_settings_id UUID;
BEGIN
  SELECT id
    INTO v_settings_id
    FROM public.settings
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
   LIMIT 1;

  IF v_settings_id IS NULL THEN
    RAISE EXCEPTION 'Global settings row missing for category=domain_event_policy';
  END IF;

  UPDATE public.settings
     SET cached_value = jsonb_set(
         COALESCE(cached_value, '{"events": {}}'::jsonb),
         ARRAY['events','settings_change.requested','workflow_template_id'],
         to_jsonb('99990000-0000-0000-0000-000000560020'::text),
         TRUE
     ),
         last_updated = now()
   WHERE id = v_settings_id;
END$$;

SELECT pg_advisory_unlock(hashtext('202512301000_settings_approval_workflow'));

COMMIT;

ALTER TABLE public.manual_review_tasks
  ADD COLUMN IF NOT EXISTS resource_type TEXT,
  ADD COLUMN IF NOT EXISTS resource_id UUID,
  ADD COLUMN IF NOT EXISTS resolution_outcome TEXT,
  ADD COLUMN IF NOT EXISTS resolved_by UUID REFERENCES public.users(id);

ALTER TABLE public.manual_review_tasks
  DROP CONSTRAINT IF EXISTS manual_review_tasks_resource_consistency_check;
ALTER TABLE public.manual_review_tasks
  ADD CONSTRAINT manual_review_tasks_resource_consistency_check
  CHECK (
    (resource_type IS NULL AND resource_id IS NULL)
    OR (btrim(resource_type) <> '' AND resource_id IS NOT NULL)
  );

ALTER TABLE public.manual_review_tasks
  DROP CONSTRAINT IF EXISTS manual_review_tasks_resolution_outcome_check;
ALTER TABLE public.manual_review_tasks
  ADD CONSTRAINT manual_review_tasks_resolution_outcome_check
  CHECK (
    resolution_outcome IS NULL
    OR resolution_outcome IN ('approved', 'rejected', 'resolved', 'canceled')
  );

ALTER TABLE public.manual_review_tasks
  DROP CONSTRAINT IF EXISTS manual_review_tasks_address_client_required_check;
ALTER TABLE public.manual_review_tasks
  ADD CONSTRAINT manual_review_tasks_address_client_required_check
  CHECK (address_id IS NULL OR client_id IS NOT NULL);

CREATE INDEX IF NOT EXISTS idx_manual_review_tasks_resource
  ON public.manual_review_tasks (resource_type, resource_id);

CREATE INDEX IF NOT EXISTS idx_manual_review_tasks_task_status
  ON public.manual_review_tasks (task_type, status);

-- =============================================================================
-- 2) RLS: manual_review_tasks read policy must honor dynamic access scopes
-- =============================================================================

DROP POLICY IF EXISTS manual_review_tasks_service_policy ON public.manual_review_tasks;
CREATE POLICY manual_review_tasks_service_policy ON public.manual_review_tasks
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS manual_review_tasks_read_policy ON public.manual_review_tasks;
CREATE POLICY manual_review_tasks_read_policy ON public.manual_review_tasks
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND (
        public.current_user_scope_type() = 'tenant'
        OR (public.current_user_scope_type() = 'client' AND client_id = public.current_user_scope_id())
        OR (public.current_user_scope_type() = 'sender' AND sender_id = public.current_user_scope_id())
      )
    )
  );

-- =============================================================================
-- 3) Manual review handler: capture resource + propagate task id via context_patch
-- =============================================================================

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_payload JSONB := CASE
        WHEN jsonb_typeof(v_ctx->'payload') = 'object' THEN COALESCE(v_ctx->'payload', '{}'::jsonb)
        ELSE '{}'::jsonb
    END;

    v_org UUID := NULLIF(v_ctx->>'organization_id', '')::UUID;
    v_client UUID := NULLIF(v_ctx->>'client_id', '')::UUID;
    v_sender UUID := NULLIF(v_ctx->>'sender_id', '')::UUID;
    v_address UUID := NULLIF(v_ctx->>'address_id', '')::UUID;
    v_shipment UUID := NULLIF(v_ctx->>'shipment_id', '')::UUID;

    v_resource_type TEXT := NULLIF(COALESCE(v_ctx->>'resource_type', v_payload->>'resource_type'), '');
    v_resource_id_text TEXT := NULLIF(COALESCE(v_ctx->>'resource_id', v_payload->>'resource_id'), '');
    v_resource_id UUID := NULL;

    v_task_type TEXT := COALESCE(NULLIF(p_step.metadata->>'task_type', ''), 'geocoding');
    v_reason TEXT := COALESCE(
        NULLIF(p_step.metadata->>'reason', ''),
        NULLIF(v_ctx->>'reason', ''),
        NULLIF(v_payload->>'reason', ''),
        p_operation_result->>'reason'
    );
    v_queue TEXT := NULLIF(p_step.metadata->>'queue_assignment', '');
    v_sla_minutes INT := COALESCE(NULLIF(p_step.metadata->>'sla_minutes', '')::INT, NULLIF(v_ctx->>'sla_minutes', '')::INT);
    v_due_at TIMESTAMPTZ := CASE WHEN v_sla_minutes IS NOT NULL THEN now() + make_interval(mins => v_sla_minutes) ELSE NULL END;
    v_task_id UUID := gen_random_uuid();
    v_resp workflow_handler_response;
BEGIN
    IF v_org IS NULL THEN
        v_org := NULLIF(v_payload->>'organization_id', '')::UUID;
    END IF;
    IF v_client IS NULL THEN
        v_client := NULLIF(v_payload->>'client_id', '')::UUID;
    END IF;
    IF v_sender IS NULL THEN
        v_sender := NULLIF(v_payload->>'sender_id', '')::UUID;
    END IF;
    IF v_address IS NULL THEN
        v_address := NULLIF(v_payload->>'address_id', '')::UUID;
    END IF;
    IF v_shipment IS NULL THEN
        v_shipment := NULLIF(v_payload->>'shipment_id', '')::UUID;
        IF v_shipment IS NULL AND v_payload ? 'resource_type' AND v_payload->>'resource_type' = 'shipment' THEN
            v_shipment := NULLIF(v_payload->>'resource_id', '')::UUID;
        END IF;
    END IF;
    IF v_shipment IS NULL AND v_ctx ? 'resource_type' AND v_ctx->>'resource_type' = 'shipment' THEN
        v_shipment := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_resource_id_text IS NOT NULL THEN
      BEGIN
        v_resource_id := v_resource_id_text::UUID;
      EXCEPTION WHEN OTHERS THEN
        v_resource_id := NULL;
      END;
    END IF;

    IF v_org IS NULL THEN
        v_org := current_user_org_id();
    END IF;

    INSERT INTO public.manual_review_tasks (
        id,
        organization_id,
        client_id,
        sender_id,
        address_id,
        shipment_id,
        resource_type,
        resource_id,
        task_type,
        reason,
        status,
        queue_assignment,
        sla_minutes,
        sla_due_at,
        metadata
    ) VALUES (
        v_task_id,
        v_org,
        v_client,
        v_sender,
        v_address,
        v_shipment,
        NULLIF(lower(btrim(v_resource_type)), ''),
        v_resource_id,
        v_task_type,
        v_reason,
        'pending',
        v_queue,
        v_sla_minutes,
        v_due_at,
        jsonb_strip_nulls(jsonb_build_object('workflow_run_id', p_run.id, 'step_id', p_step.id))
    );

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'manual_review',
        p_resource_type := 'manual_review_task',
        p_resource_id := v_task_id,
        p_decision_point := 'enqueue_task',
        p_decision_outcome := 'created',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'task_type', v_task_type,
            'reason', v_reason,
            'resource_type', v_resource_type,
            'resource_id', v_resource_id
        )),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.workflow_status := NULL;
    v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
    v_resp.context_patch := jsonb_build_object('manual_review_task_id', v_task_id);
    RETURN v_resp;
END;
$$;

-- =============================================================================
-- 4) RPC: resolve manual_review task with an explicit outcome (approve/reject)
-- =============================================================================

CREATE OR REPLACE FUNCTION public.resolve_manual_review_task_v1(
  p_task_id UUID,
  p_resolution_outcome TEXT,
  p_resolution_notes TEXT DEFAULT NULL
)
RETURNS public.manual_review_tasks
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_task public.manual_review_tasks%ROWTYPE;
  v_outcome TEXT := lower(COALESCE(NULLIF(p_resolution_outcome, ''), ''));
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'resolve_manual_review_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'resolve_manual_review_task_v1 requires tenant/platform write scope';
  END IF;
  IF v_outcome NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'Unsupported resolution_outcome % (expected approved|rejected)', p_resolution_outcome
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_task
    FROM public.manual_review_tasks mrt
   WHERE mrt.id = p_task_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'manual_review_task not found: %', p_task_id;
  END IF;

  IF NOT public.is_platform_user() AND v_task.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'manual_review_task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF v_task.status = 'resolved' THEN
    RETURN v_task;
  END IF;

  UPDATE public.manual_review_tasks
     SET status = 'resolved',
         resolution_outcome = v_outcome,
         resolution_notes = p_resolution_notes,
         resolved_by = v_user_id,
         resolved_at = now(),
         updated_at = now()
   WHERE id = p_task_id
   RETURNING * INTO v_task;

  PERFORM public.log_decision(
      p_organization_id := v_task.organization_id,
      p_decision_category := 'manual_review',
      p_resource_type := 'manual_review_task',
      p_resource_id := p_task_id,
      p_decision_point := 'resolve_task',
      p_decision_outcome := v_outcome,
      p_performed_by_system := 'resolve_manual_review_task_v1',
      p_correlation_id := NULL,
      p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
        'task_type', v_task.task_type,
        'resource_type', v_task.resource_type,
        'resource_id', v_task.resource_id
      )),
      p_decision_reason := p_resolution_notes
  );

  RETURN v_task;
END;
$$;

REVOKE ALL ON FUNCTION public.resolve_manual_review_task_v1(UUID, TEXT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.resolve_manual_review_task_v1(UUID, TEXT, TEXT) TO authenticated, service_role;

-- =============================================================================
-- 5) Handler: wait for manual review resolution (blocking step)
-- =============================================================================

CREATE OR REPLACE FUNCTION workflow_handlers.execute_manual_review_wait_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id_text TEXT := COALESCE(
      p_operation_result->>'manual_review_task_id',
      p_step.operation_result->>'manual_review_task_id',
      v_ctx->>'manual_review_task_id'
    );
    v_task_id UUID;
    v_poll_seconds INT := COALESCE(NULLIF(p_step.metadata->>'poll_interval_seconds', '')::INT, 60);
    v_task public.manual_review_tasks%ROWTYPE;
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id_text IS NOT NULL AND btrim(v_task_id_text) <> '' THEN
        v_task_id := v_task_id_text::UUID;
    END IF;
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'manual_review_wait: manual_review_task_id missing (workflow_run_id=% step_id=%)', p_run.id, p_step.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'manual_review_wait: manual_review_task_id % not found', v_task_id;
    END IF;

    IF v_task.metadata ? 'workflow_run_id'
       AND NULLIF(v_task.metadata->>'workflow_run_id', '')::UUID IS DISTINCT FROM p_run.id THEN
        RAISE EXCEPTION 'manual_review_wait: task % does not belong to workflow_run_id=%', v_task_id, p_run.id;
    END IF;

    IF v_poll_seconds < 0 THEN
      v_poll_seconds := 60;
    END IF;

    IF v_task.status <> 'resolved' THEN
        v_resp.status := 'pending';
        v_resp.next_run_at := now() + make_interval(secs => v_poll_seconds);
        v_resp.operation_result := jsonb_build_object('manual_review_task_id', v_task_id);
        RETURN v_resp;
    END IF;

    IF v_task.resolution_outcome IS NULL OR v_task.resolution_outcome NOT IN ('approved', 'rejected') THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'manual_review_wait: resolved without supported resolution_outcome';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resolution_outcome = 'rejected' THEN
        v_resp.status := 'failed';
        v_resp.last_error := COALESCE(v_task.resolution_notes, 'manual_review rejected');
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes,
          'resolved_by', v_task.resolved_by,
          'resolved_at', v_task.resolved_at
        ));
        RETURN v_resp;
    END IF;

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'manual_review_task_id', v_task_id,
      'resolution_outcome', v_task.resolution_outcome,
      'resolution_notes', v_task.resolution_notes,
      'resolved_by', v_task.resolved_by,
      'resolved_at', v_task.resolved_at
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'manual_review', jsonb_build_object(
        'task_id', v_task_id,
        'outcome', v_task.resolution_outcome,
        'resolved_by', v_task.resolved_by,
        'resolved_at', v_task.resolved_at,
        'resolution_notes', v_task.resolution_notes
      )
    ));
    RETURN v_resp;
END;
$$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
) VALUES
(
  'manual_review_wait',
  'workflow_handlers',
  'execute_manual_review_wait_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Block workflow progression until a manual_review_tasks row is resolved (approved/rejected).',
  'docs/product/guides/handlers-cookbook.md'
)
,
(
  'settings_apply',
  'workflow_handlers',
  'execute_settings_apply_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply an approved settings_versions row into settings (cache) and close prior current version.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-- =============================================================================
-- 6.5) Register settings_apply handler (FK requirement for workflow steps)
-- =============================================================================

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
) VALUES (
  'settings_apply',
  'workflow_handlers',
  'execute_settings_apply_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply an approved settings_versions row into settings (cache) and close prior current version.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

-- =============================================================================
-- 7) Workflow template: settings_change_approval_v1
-- =============================================================================

DO $$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000560020'::UUID;
  v_step_1 UUID := '99990000-0000-0000-0000-000000560021'::UUID;
  v_step_2 UUID := '99990000-0000-0000-0000-000000560022'::UUID;
  v_step_3 UUID := '99990000-0000-0000-0000-000000560023'::UUID;
BEGIN
  INSERT INTO public.workflow_templates (
    id,
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    notes,
    created_at,
    updated_at
  ) VALUES (
    v_template_id,
    'settings_change_approval_v1',
    'Approve a pending settings_versions change via manual_review_tasks then apply it.',
    'active',
    1,
    'global',
    NULL,
    'SSOT: settings approvals are modeled as workflows + manual_review_tasks (no bespoke queue table).',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE SET
    name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    version = EXCLUDED.version,
    scope_type = EXCLUDED.scope_type,
    scope_id = EXCLUDED.scope_id,
    notes = EXCLUDED.notes,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  ) VALUES (
    v_step_1,
    v_template_id,
    1,
    'settings_change_manual_review_enqueue',
    'always',
    jsonb_build_object('task_type','settings_approval'),
    TRUE,
    'manual_review',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  ) VALUES (
    v_step_2,
    v_template_id,
    2,
    'settings_change_manual_review_wait',
    'always',
    jsonb_build_object('poll_interval_seconds', 60),
    TRUE,
    'manual_review_wait',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();

  INSERT INTO public.workflow_template_steps (
    id,
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    enabled,
    handler_key,
    handler_version
  ) VALUES (
    v_step_3,
    v_template_id,
    3,
    'settings_change_apply',
    'always',
    '{}'::jsonb,
    TRUE,
    'settings_apply',
    'v1'
  )
  ON CONFLICT (id) DO UPDATE SET
    workflow_template_id = EXCLUDED.workflow_template_id,
    sequence_order = EXCLUDED.sequence_order,
    operation_name = EXCLUDED.operation_name,
    transition_condition = EXCLUDED.transition_condition,
    metadata = EXCLUDED.metadata,
    enabled = EXCLUDED.enabled,
    handler_key = EXCLUDED.handler_key,
    handler_version = EXCLUDED.handler_version,
    updated_at = now();
END$$;

-- =============================================================================
-- 6) Handler: apply approved settings_version into settings (active cache)
-- =============================================================================

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settings_apply_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id UUID := NULLIF(v_ctx->>'manual_review_task_id', '')::UUID;

    v_task public.manual_review_tasks%ROWTYPE;
    v_settings_version_id UUID;
    v_sv public.settings_versions%ROWTYPE;

    v_org UUID;
    v_now TIMESTAMPTZ := now();
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id missing from workflow context (workflow_run_id=%)', p_run.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id % not found', v_task_id;
    END IF;

    IF v_task.status <> 'resolved' OR v_task.resolution_outcome IS DISTINCT FROM 'approved' THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'settings_apply: approval missing or rejected';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resource_type = 'settings_version' AND v_task.resource_id IS NOT NULL THEN
      v_settings_version_id := v_task.resource_id;
    ELSE
      v_settings_version_id := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_settings_version_id IS NULL THEN
      RAISE EXCEPTION 'settings_apply: settings_version_id missing (manual_review_task_id=%)', v_task_id;
    END IF;

    SELECT *
      INTO v_sv
      FROM public.settings_versions sv
     WHERE sv.id = v_settings_version_id
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_apply: settings_versions row not found for id=%', v_settings_version_id;
    END IF;

    v_org := COALESCE(v_task.organization_id, NULLIF(v_ctx->'payload'->>'organization_id', '')::UUID, public.current_user_org_id());
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'settings_apply: organization_id missing for decision log (settings_version_id=%)', v_settings_version_id;
    END IF;

    -- Close prior approved current row first (avoid unique current conflict).
    UPDATE public.settings_versions
       SET effective_until = v_now
     WHERE category = v_sv.category
       AND scope_type = v_sv.scope_type
       AND scope_hash = v_sv.scope_hash
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND id <> v_settings_version_id;

    -- Approve the requested settings version (idempotent).
    UPDATE public.settings_versions
       SET approved_at = COALESCE(approved_at, v_task.resolved_at, v_now),
           approved_by = COALESCE(approved_by, v_task.resolved_by),
           effective_from = CASE WHEN approved_at IS NULL THEN v_now ELSE effective_from END
     WHERE id = v_settings_version_id
       AND scope_hash = v_sv.scope_hash;

    -- Apply to active settings cache.
    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      gen_random_uuid(),
      v_sv.category,
      v_sv.scope_type,
      v_sv.scope_id,
      v_sv.scope_hash,
      v_settings_version_id,
      v_sv.value,
      v_now
    )
    ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET scope_id = EXCLUDED.scope_id,
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings',
        p_resource_type := 'settings_version',
        p_resource_id := v_settings_version_id,
        p_decision_point := 'apply',
        p_decision_outcome := 'applied',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'category', v_sv.category,
          'scope_type', v_sv.scope_type,
          'scope_id', v_sv.scope_id,
          'manual_review_task_id', v_task_id,
          'approved_by', v_task.resolved_by
        )),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'settings_version_id', v_settings_version_id,
      'category', v_sv.category,
      'scope_type', v_sv.scope_type,
      'scope_id', v_sv.scope_id
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settings_applied', jsonb_build_object(
        'settings_version_id', v_settings_version_id,
        'category', v_sv.category,
        'scope_type', v_sv.scope_type,
        'scope_id', v_sv.scope_id,
        'applied_at', v_now
      )
    ));
    RETURN v_resp;
END;
$$;
