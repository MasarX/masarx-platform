-- Plan: B04 UC062 zone override approval / Step: E01
-- Migration: manual zone override with reason + approval workflow
-- Date: 2026-04-06
--
-- Purpose:
--   - Add a durable zone_override_requests ledger for wrong-zone exception review.
--   - Reuse the canonical workflow-engine manual review + manual_review_wait path.
--   - Apply approved overrides by updating shipment.zone_id and reusing the
--     canonical mis-sort reassignment substrate.
--   - Expose a browser-safe dedicated UI RPC and registry action with
--     input_schema for override_reason + requested_zone_id.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061530_b04_uc062_zone_override_approval_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.zone_override_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  shipment_id UUID NOT NULL,
  shipment_client_id UUID NOT NULL,
  source_exception_id UUID NOT NULL,
  current_zone_id UUID NULL,
  expected_zone_id UUID NULL,
  requested_zone_id UUID NOT NULL,
  request_reason TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'rejected', 'applied', 'failed', 'cancelled')),
  workflow_run_id UUID NULL REFERENCES public.workflow_runs(id) ON DELETE SET NULL,
  manual_review_task_id UUID NULL REFERENCES public.manual_review_tasks(id) ON DELETE SET NULL,
  requested_by UUID NULL,
  reviewed_by UUID NULL,
  reviewed_at TIMESTAMPTZ NULL,
  resolution_outcome TEXT NULL,
  resolution_notes TEXT NULL,
  applied_at TIMESTAMPTZ NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
    CHECK (jsonb_typeof(metadata) = 'object'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_zone_override_requests_shipment_status
  ON public.zone_override_requests (shipment_id, shipment_client_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_zone_override_requests_manual_review_task
  ON public.zone_override_requests (manual_review_task_id)
  WHERE manual_review_task_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_zone_override_requests_open_per_shipment
  ON public.zone_override_requests (shipment_id, shipment_client_id)
  WHERE status IN ('pending', 'approved');

ALTER TABLE public.zone_override_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS zone_override_requests_service_policy ON public.zone_override_requests;
CREATE POLICY zone_override_requests_service_policy
  ON public.zone_override_requests
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS zone_override_requests_authenticated_select ON public.zone_override_requests;
CREATE POLICY zone_override_requests_authenticated_select
  ON public.zone_override_requests
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR organization_id = public.current_user_org_id()
  );

CREATE OR REPLACE FUNCTION public.zone_override_requests_sync_manual_review_resolution_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_request public.zone_override_requests%ROWTYPE;
  v_payload JSONB;
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RETURN NEW;
  END IF;

  IF COALESCE(NEW.status, '') <> 'resolved' OR COALESCE(NEW.resolution_outcome, '') = '' THEN
    RETURN NEW;
  END IF;

  SELECT *
    INTO v_request
    FROM public.zone_override_requests zor
   WHERE zor.manual_review_task_id = NEW.id
   LIMIT 1;

  IF v_request.id IS NULL THEN
    RETURN NEW;
  END IF;

  UPDATE public.zone_override_requests
     SET status = CASE
           WHEN lower(NEW.resolution_outcome) = 'approved' THEN 'approved'
           WHEN lower(NEW.resolution_outcome) = 'rejected' THEN 'rejected'
           ELSE status
         END,
         reviewed_by = NEW.resolved_by,
         reviewed_at = NEW.resolved_at,
         resolution_outcome = lower(NEW.resolution_outcome),
         resolution_notes = NEW.resolution_notes,
         updated_at = now(),
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'manual_review_task_id', NEW.id,
           'manual_review_status', NEW.status,
           'resolution_outcome', lower(NEW.resolution_outcome)
         ))
   WHERE id = v_request.id;

  IF v_request.workflow_run_id IS NOT NULL THEN
    v_payload := jsonb_strip_nulls(jsonb_build_object(
      'manual_review_task_id', NEW.id,
      'resolution_outcome', lower(NEW.resolution_outcome),
      'resolution_notes', NEW.resolution_notes,
      'resolved_by', NEW.resolved_by,
      'resolved_at', NEW.resolved_at
    ));

    BEGIN
      PERFORM public.progress_workflow_run(v_request.workflow_run_id, v_payload);
      PERFORM public.progress_workflow_run(v_request.workflow_run_id, v_payload);
    EXCEPTION
      WHEN OTHERS THEN
        UPDATE public.zone_override_requests
           SET status = CASE
                 WHEN status = 'applied' THEN status
                 ELSE 'failed'
               END,
               updated_at = now(),
               metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
                 'workflow_progress_error', SQLERRM
               ))
         WHERE id = v_request.id;
    END;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_zone_override_requests_sync_manual_review_resolution
  ON public.manual_review_tasks;
CREATE TRIGGER trg_zone_override_requests_sync_manual_review_resolution
  AFTER UPDATE OF status, resolution_outcome, resolution_notes, resolved_at, resolved_by
  ON public.manual_review_tasks
  FOR EACH ROW
  EXECUTE FUNCTION public.zone_override_requests_sync_manual_review_resolution_v1();

CREATE OR REPLACE FUNCTION workflow_handlers.execute_zone_override_apply_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_payload JSONB := CASE
    WHEN jsonb_typeof(v_ctx->'payload') = 'object' THEN COALESCE(v_ctx->'payload', '{}'::jsonb)
    ELSE '{}'::jsonb
  END;
  v_request_id UUID := COALESCE(
    NULLIF(p_operation_result->>'zone_override_request_id', '')::UUID,
    NULLIF(v_ctx->>'zone_override_request_id', '')::UUID,
    CASE
      WHEN COALESCE(v_ctx->>'resource_type', '') = 'zone_override_request'
        THEN NULLIF(v_ctx->>'resource_id', '')::UUID
      ELSE NULL
    END,
    CASE
      WHEN COALESCE(v_payload->>'resource_type', '') = 'zone_override_request'
        THEN NULLIF(v_payload->>'resource_id', '')::UUID
      ELSE NULL
    END
  );
  v_request public.zone_override_requests%ROWTYPE;
  v_existing_exception RECORD;
  v_resolved RECORD;
  v_resolved_basket_id UUID := NULL;
  v_resolved_basket_item_id UUID := NULL;
  v_now TIMESTAMPTZ := now();
  v_resp workflow_handler_response;
BEGIN
  IF v_request_id IS NULL THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 requires zone_override_request_id';
  END IF;

  SELECT *
    INTO v_request
    FROM public.zone_override_requests zor
   WHERE zor.id = v_request_id
   LIMIT 1
   FOR UPDATE;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 request % not found', v_request_id
      USING ERRCODE = '23503';
  END IF;

  IF COALESCE(
    lower(p_operation_result->>'resolution_outcome'),
    lower(v_request.resolution_outcome),
    lower(v_ctx#>>'{manual_review,outcome}')
  ) <> 'approved' THEN
    RAISE EXCEPTION 'execute_zone_override_apply_v1 requires approved manual review for request %', v_request_id;
  END IF;

  UPDATE public.shipments
     SET zone_id = v_request.requested_zone_id,
         updated_at = v_now
   WHERE id = v_request.shipment_id
     AND client_id = v_request.shipment_client_id;

  PERFORM public.sync_shipment_mis_sort_exceptions_v1(v_request.shipment_id, v_request.shipment_client_id);

  SELECT *
    INTO v_existing_exception
    FROM public.mis_sort_exceptions mse
   WHERE mse.shipment_id = v_request.shipment_id
     AND mse.shipment_client_id = v_request.shipment_client_id
   ORDER BY mse.detected_at DESC, mse.updated_at DESC, mse.id DESC
   LIMIT 1;

  IF FOUND AND v_existing_exception.id IS NOT NULL THEN
    SELECT *
      INTO v_resolved
      FROM public.resolve_mis_sort_exception_v1(v_existing_exception.id, '{}'::jsonb)
     LIMIT 1;
    v_resolved_basket_id := v_resolved.basket_id;
    v_resolved_basket_item_id := v_resolved.basket_item_id;
  END IF;

  PERFORM public.sync_shipment_mis_sort_exceptions_v1(v_request.shipment_id, v_request.shipment_client_id);

  UPDATE public.zone_override_requests
     SET status = 'applied',
         applied_at = v_now,
         updated_at = v_now,
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'applied_basket_id', v_resolved_basket_id,
           'applied_basket_item_id', v_resolved_basket_item_id
         ))
   WHERE id = v_request.id;

  INSERT INTO public.shipment_actions (
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
    v_request.shipment_id,
    v_request.organization_id,
    v_request.shipment_client_id,
    'zone_override_applied',
    'operational',
    jsonb_strip_nulls(jsonb_build_object(
      'zone_override_request_id', v_request.id,
      'source_exception_id', v_request.source_exception_id,
      'current_zone_id', v_request.current_zone_id,
      'expected_zone_id', v_request.expected_zone_id,
      'requested_zone_id', v_request.requested_zone_id,
      'basket_id', v_resolved_basket_id,
      'basket_item_id', v_resolved_basket_item_id
    )),
    v_now,
    v_now,
    'workflow_engine'
  );

  PERFORM public.log_decision(
    p_organization_id := v_request.organization_id,
    p_decision_category := 'zone_override',
    p_resource_type := 'zone_override_request',
    p_resource_id := v_request.id,
    p_decision_point := 'apply',
    p_decision_outcome := 'applied',
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := p_run.id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'shipment_id', v_request.shipment_id,
      'source_exception_id', v_request.source_exception_id,
      'requested_zone_id', v_request.requested_zone_id,
      'resolution_outcome', v_request.resolution_outcome
    )),
    p_decision_reason := v_request.request_reason
  );

  v_resp.status := 'completed';
  v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
    'zone_override_request_id', v_request.id,
    'shipment_id', v_request.shipment_id,
    'requested_zone_id', v_request.requested_zone_id,
    'basket_id', v_resolved_basket_id,
    'basket_item_id', v_resolved_basket_item_id,
    'status', 'applied'
  ));
  v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
    'zone_override_request_id', v_request.id,
    'zone_override', jsonb_build_object(
      'status', 'applied',
      'requested_zone_id', v_request.requested_zone_id,
      'applied_at', v_now
    )
  ));
  RETURN v_resp;
EXCEPTION
  WHEN OTHERS THEN
    IF v_request_id IS NOT NULL THEN
      UPDATE public.zone_override_requests
         SET status = CASE
               WHEN status = 'applied' THEN status
               ELSE 'failed'
             END,
             updated_at = now(),
             metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
               'apply_error', SQLERRM
             ))
       WHERE id = v_request_id;
    END IF;
    RAISE;
END;
$function$;

COMMENT ON FUNCTION workflow_handlers.execute_zone_override_apply_v1(workflow_run_steps, workflow_runs, JSONB) IS
  'Apply an approved manual zone override, then reconcile the shipment into the canonical basket assignment for the new zone.';

INSERT INTO public.operation_handlers AS oh (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'zone_override_apply',
  'workflow_handlers',
  'execute_zone_override_apply_v1',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v1',
  TRUE,
  'Apply approved zone_override_requests through shipment zone update + mis-sort reassignment.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
   SET handler_schema = EXCLUDED.handler_schema,
       handler_name = EXCLUDED.handler_name,
       handler_signature = EXCLUDED.handler_signature,
       handler_version = EXCLUDED.handler_version,
       is_active = EXCLUDED.is_active,
       notes = EXCLUDED.notes,
       doc_url = EXCLUDED.doc_url;

DO $do$
DECLARE
  v_template_id UUID := '99990000-0000-0000-0000-000000560062'::UUID;
BEGIN
  INSERT INTO public.workflow_templates AS wt (
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
  )
  VALUES (
    v_template_id,
    'zone_override_approval_v1',
    'Manual zone override request with explicit review approval before shipment zone mutation.',
    'active',
    1,
    'global',
    NULL,
    'B04 UC062 manual zone override approval',
    now(),
    now()
  )
  ON CONFLICT (id) DO UPDATE
     SET name = EXCLUDED.name,
         description = EXCLUDED.description,
         status = EXCLUDED.status,
         version = EXCLUDED.version,
         scope_type = EXCLUDED.scope_type,
         scope_id = EXCLUDED.scope_id,
         notes = EXCLUDED.notes,
         updated_at = now();

  DELETE FROM public.workflow_template_steps
   WHERE workflow_template_id = v_template_id
     AND sequence_order IN (1, 2, 3);

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    operation_settings_category,
    transition_condition,
    handler_key,
    handler_version,
    metadata,
    enabled,
    created_at,
    updated_at
  )
  VALUES
    (
      v_template_id,
      1,
      'manual_review',
      'approval',
      'always',
      'manual_review',
      'v1',
      jsonb_build_object(
        'task_type', 'zone_override_approval',
        'queue_assignment', 'sortation',
        'decision_log_event', 'zone_override.review_requested'
      ),
      TRUE,
      now(),
      now()
    ),
    (
      v_template_id,
      2,
      'manual_review_wait',
      'approval',
      'always',
      'manual_review_wait',
      'v1',
      jsonb_build_object(
        'poll_interval_seconds', 30,
        'decision_log_event', 'zone_override.review_wait'
      ),
      TRUE,
      now(),
      now()
    ),
    (
      v_template_id,
      3,
      'zone_override_apply',
      'approval',
      'always',
      'zone_override_apply',
      'v1',
      jsonb_build_object(
        'decision_log_event', 'zone_override.apply'
      ),
      TRUE,
      now(),
      now()
    );
END;
$do$;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'manual_review_task_type'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM def
CROSS JOIN (VALUES
  (
    'zone_override_approval',
    'Zone Override Approval',
    'Manual review task for wrong-zone override requests before shipment zone mutation.',
    30,
    false,
    '{}'::jsonb
  )
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM def
CROSS JOIN (VALUES
  (
    'zone_override',
    'Zone Override',
    'Decision log category for wrong-zone override review and apply actions.',
    200,
    false,
    '{}'::jsonb
  )
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

WITH def AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  def.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM def
CROSS JOIN (VALUES
  (
    'pending_review',
    'Pending Review',
    'Decision outcome for requests waiting on explicit operator approval.',
    210,
    false,
    '{}'::jsonb
  ),
  (
    'applied',
    'Applied',
    'Decision outcome for approved overrides that were applied successfully.',
    220,
    false,
    '{}'::jsonb
  )
) AS v(value, label, description, sort_order, is_default, metadata)
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE OR REPLACE FUNCTION public.request_zone_override_v1(
  p_exception_id UUID,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  request_id UUID,
  workflow_run_id UUID,
  manual_review_task_id UUID,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_exception RECORD;
  v_requested_zone_text TEXT := NULLIF(btrim(COALESCE(p_params->>'requested_zone_id', '')), '');
  v_requested_zone_id UUID := NULL;
  v_override_reason TEXT := NULLIF(btrim(COALESCE(p_params->>'override_reason', '')), '');
  v_existing_request_id UUID := NULL;
  v_template_id UUID := '99990000-0000-0000-0000-000000560062'::UUID;
  v_workflow_run_id UUID := NULL;
  v_manual_review_task_id UUID := NULL;
  v_first_progress JSONB := '{}'::jsonb;
  v_request_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('baskets.write', v_scope_type, v_scope_id);

  IF p_exception_id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 requires exception id';
  END IF;

  IF v_override_reason IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 requires override_reason';
  END IF;

  SELECT *
    INTO v_exception
    FROM public.mis_sort_exceptions mse
   WHERE mse.id = p_exception_id
     AND mse.exception_reason = 'wrong_zone'
   LIMIT 1;

  IF v_exception.id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 wrong-zone exception % not found', p_exception_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_exception.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'request_zone_override_v1 exception % is outside current tenant scope', p_exception_id
      USING ERRCODE = '42501';
  END IF;

  IF v_requested_zone_text IS NOT NULL THEN
    BEGIN
      v_requested_zone_id := v_requested_zone_text::UUID;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'request_zone_override_v1 invalid requested_zone_id %', v_requested_zone_text;
    END;
  ELSE
    v_requested_zone_id := v_exception.actual_zone_id;
  END IF;

  IF v_requested_zone_id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 could not resolve requested_zone_id';
  END IF;

  IF v_requested_zone_id = v_exception.expected_zone_id THEN
    RAISE EXCEPTION 'request_zone_override_v1 requested zone matches canonical expected zone; use resolve_reassign instead'
      USING ERRCODE = '23514';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.zones z
     WHERE z.id = v_requested_zone_id
       AND z.organization_id = v_exception.organization_id
       AND COALESCE(z.is_active, TRUE) = TRUE
  ) THEN
    RAISE EXCEPTION 'request_zone_override_v1 requested zone % is not active in organization %',
      v_requested_zone_id,
      v_exception.organization_id
      USING ERRCODE = '23503';
  END IF;

  SELECT zor.id
    INTO v_existing_request_id
    FROM public.zone_override_requests zor
   WHERE zor.shipment_id = v_exception.shipment_id
     AND zor.shipment_client_id = v_exception.shipment_client_id
     AND zor.status IN ('pending', 'approved')
   ORDER BY zor.created_at DESC, zor.id DESC
   LIMIT 1;

  IF v_existing_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 shipment already has open zone override request %', v_existing_request_id
      USING ERRCODE = '23505';
  END IF;

  INSERT INTO public.zone_override_requests (
    id,
    organization_id,
    shipment_id,
    shipment_client_id,
    source_exception_id,
    current_zone_id,
    expected_zone_id,
    requested_zone_id,
    request_reason,
    status,
    requested_by,
    metadata,
    created_at,
    updated_at
  )
  VALUES (
    v_request_id,
    v_exception.organization_id,
    v_exception.shipment_id,
    v_exception.shipment_client_id,
    v_exception.id,
    v_exception.actual_zone_id,
    v_exception.expected_zone_id,
    v_requested_zone_id,
    v_override_reason,
    'pending',
    v_user_id,
    jsonb_strip_nulls(jsonb_build_object(
      'basket_id', v_exception.basket_id,
      'basket_item_id', v_exception.basket_item_id,
      'exception_reason', v_exception.exception_reason
    )),
    now(),
    now()
  );

  SELECT public.start_workflow_run(
    v_template_id,
    jsonb_strip_nulls(jsonb_build_object(
      'organization_id', v_exception.organization_id,
      'client_id', v_exception.shipment_client_id,
      'shipment_id', v_exception.shipment_id,
      'resource_type', 'zone_override_request',
      'resource_id', v_request_id,
      'zone_override_request_id', v_request_id,
      'requested_zone_id', v_requested_zone_id,
      'current_zone_id', v_exception.actual_zone_id,
      'expected_zone_id', v_exception.expected_zone_id,
      'request_reason', v_override_reason,
      'payload', jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_exception.organization_id,
        'client_id', v_exception.shipment_client_id,
        'shipment_id', v_exception.shipment_id,
        'resource_type', 'zone_override_request',
        'resource_id', v_request_id,
        'requested_zone_id', v_requested_zone_id,
        'current_zone_id', v_exception.actual_zone_id,
        'expected_zone_id', v_exception.expected_zone_id,
        'request_reason', v_override_reason
      ))
    ))
  )
    INTO v_workflow_run_id;

  v_first_progress := public.progress_workflow_run(
    v_workflow_run_id,
    jsonb_build_object(
      'reason', v_override_reason,
      'zone_override_request_id', v_request_id
    )
  );

  SELECT mrt.id
    INTO v_manual_review_task_id
    FROM public.manual_review_tasks mrt
   WHERE mrt.metadata->>'workflow_run_id' = v_workflow_run_id::TEXT
   ORDER BY mrt.created_at DESC, mrt.id DESC
   LIMIT 1;

  IF v_manual_review_task_id IS NULL THEN
    RAISE EXCEPTION 'request_zone_override_v1 failed to create manual review task for workflow_run_id %', v_workflow_run_id;
  END IF;

  UPDATE public.manual_review_tasks
     SET reason = v_override_reason,
         metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
           'zone_override_request_id', v_request_id,
           'requested_zone_id', v_requested_zone_id,
           'current_zone_id', v_exception.actual_zone_id,
           'expected_zone_id', v_exception.expected_zone_id
         )),
         updated_at = now()
   WHERE id = v_manual_review_task_id;

  PERFORM public.progress_workflow_run(
    v_workflow_run_id,
    jsonb_strip_nulls(jsonb_build_object(
      'manual_review_task_id', v_manual_review_task_id,
      'zone_override_request_id', v_request_id
    ))
  );

  UPDATE public.zone_override_requests
     SET workflow_run_id = v_workflow_run_id,
         manual_review_task_id = v_manual_review_task_id,
         updated_at = now()
   WHERE id = v_request_id;

  INSERT INTO public.shipment_actions (
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
    v_exception.shipment_id,
    v_exception.organization_id,
    v_exception.shipment_client_id,
    'zone_override_requested',
    'operational',
    jsonb_strip_nulls(jsonb_build_object(
      'zone_override_request_id', v_request_id,
      'source_exception_id', v_exception.id,
      'current_zone_id', v_exception.actual_zone_id,
      'expected_zone_id', v_exception.expected_zone_id,
      'requested_zone_id', v_requested_zone_id,
      'manual_review_task_id', v_manual_review_task_id,
      'workflow_run_id', v_workflow_run_id,
      'workflow_status', v_first_progress->>'status'
    )),
    now(),
    now(),
    'request_zone_override_v1'
  );

  PERFORM public.log_decision(
    p_organization_id := v_exception.organization_id,
    p_decision_category := 'zone_override',
    p_resource_type := 'zone_override_request',
    p_resource_id := v_request_id,
    p_decision_point := 'request',
    p_decision_outcome := 'pending_review',
    p_performed_by_system := 'request_zone_override_v1',
    p_correlation_id := v_workflow_run_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'source_exception_id', v_exception.id,
      'shipment_id', v_exception.shipment_id,
      'current_zone_id', v_exception.actual_zone_id,
      'expected_zone_id', v_exception.expected_zone_id,
      'requested_zone_id', v_requested_zone_id
    )),
    p_decision_reason := v_override_reason
  );

  request_id := v_request_id;
  workflow_run_id := v_workflow_run_id;
  manual_review_task_id := v_manual_review_task_id;
  status := 'pending';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.request_zone_override_v1(UUID, JSONB) IS
  'Create a durable wrong-zone override request, enqueue a manual-review workflow, and return the request/task identifiers.';

CREATE OR REPLACE FUNCTION public.ui_execute_zone_override_request_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_command_registry', v_scope_type, v_scope_id);
  v_command JSONB := NULL;
  v_selection JSONB := '{}'::jsonb;
  v_capability TEXT := NULL;
  v_mode TEXT := '';
  v_min INTEGER := 0;
  v_max INTEGER := NULL;
  v_ids TEXT[] := COALESCE(
    p_selection_ids,
    CASE
      WHEN p_selection_id IS NULL OR btrim(p_selection_id) = '' THEN ARRAY[]::TEXT[]
      ELSE ARRAY[p_selection_id]
    END
  );
  v_count INTEGER := COALESCE(p_selection_count, COALESCE(array_length(v_ids, 1), 0));
  v_selection_id_text TEXT;
  v_selection_uuid UUID;
  v_result RECORD;
  v_results JSONB := '[]'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF p_action_key IS NULL OR btrim(p_action_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 requires action key';
  END IF;

  IF p_resource_key IS NULL OR btrim(p_resource_key) = '' THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 requires resource key';
  END IF;

  SELECT value
    INTO v_command
    FROM jsonb_array_elements(COALESCE(v_registry->'commands', '[]'::jsonb)) AS value
   WHERE value->>'key' = p_action_key
   LIMIT 1;

  IF v_command IS NULL THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 unknown command %', p_action_key;
  END IF;

  v_capability := NULLIF(v_command->>'capability', '');
  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_selection := COALESCE(v_command->'selection', '{}'::jsonb);
  v_mode := lower(COALESCE(NULLIF(v_selection->>'mode', ''), ''));
  v_min := COALESCE(
    NULLIF(v_selection->>'min_count', '')::INT,
    CASE WHEN v_mode IN ('none', 'any') THEN 0 ELSE 1 END
  );
  v_max := COALESCE(
    NULLIF(v_selection->>'max_count', '')::INT,
    CASE WHEN v_mode = 'single' THEN 1 ELSE NULL END
  );

  IF v_min IS NOT NULL AND v_count < v_min THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 selection below minimum %', v_min;
  END IF;
  IF v_max IS NOT NULL AND v_count > v_max THEN
    RAISE EXCEPTION 'ui_execute_zone_override_request_v1 selection above maximum %', v_max;
  END IF;

  FOREACH v_selection_id_text IN ARRAY v_ids LOOP
    BEGIN
      v_selection_uuid := NULLIF(btrim(v_selection_id_text), '')::UUID;
    EXCEPTION
      WHEN OTHERS THEN
        RAISE EXCEPTION 'ui_execute_zone_override_request_v1 invalid exception id %', v_selection_id_text;
    END;

    IF v_selection_uuid IS NULL THEN
      CONTINUE;
    END IF;

    IF public.ui_get_resource_v1(p_resource_key, v_selection_uuid) IS NULL THEN
      RAISE EXCEPTION
        'ui_execute_zone_override_request_v1 exception % is not visible in resource %',
        v_selection_uuid,
        p_resource_key
        USING ERRCODE = '42501';
    END IF;

    SELECT *
      INTO v_result
      FROM public.request_zone_override_v1(v_selection_uuid, COALESCE(p_params, '{}'::jsonb))
     LIMIT 1;

    v_results := v_results || jsonb_build_array(
      jsonb_strip_nulls(jsonb_build_object(
        'request_id', v_result.request_id,
        'workflow_run_id', v_result.workflow_run_id,
        'manual_review_task_id', v_result.manual_review_task_id,
        'status', v_result.status
      ))
    );
  END LOOP;

  RETURN jsonb_build_object(
    'status', 'pending_review',
    'count', COALESCE(jsonb_array_length(v_results), 0),
    'items', v_results
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) IS
  'Submit visible wrong-zone exceptions into the dedicated zone-override approval workflow without widening ui_execute_command_v1.';

CREATE OR REPLACE FUNCTION api.ui_execute_zone_override_request_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[] DEFAULT NULL,
  p_selection_id TEXT DEFAULT NULL,
  p_selection_count INTEGER DEFAULT NULL,
  p_params JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
  SELECT public.ui_execute_zone_override_request_v1($1, $2, $3, $4, $5, $6);
$function$;

REVOKE ALL ON TABLE public.zone_override_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.zone_override_requests FROM anon;
REVOKE ALL ON TABLE public.zone_override_requests FROM authenticated;
GRANT SELECT ON TABLE public.zone_override_requests TO authenticated, service_role;

REVOKE ALL ON FUNCTION workflow_handlers.execute_zone_override_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION workflow_handlers.execute_zone_override_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM anon;
REVOKE ALL ON FUNCTION workflow_handlers.execute_zone_override_apply_v1(workflow_run_steps, workflow_runs, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_zone_override_apply_v1(workflow_run_steps, workflow_runs, JSONB) TO service_role;

REVOKE ALL ON FUNCTION public.request_zone_override_v1(UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_zone_override_v1(UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.request_zone_override_v1(UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_zone_override_v1(UUID, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION public.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

REVOKE ALL ON FUNCTION api.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_zone_override_request_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated, service_role;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
  v_canonical_command JSONB := jsonb_build_object(
    'key', 'wrong_zone_exceptions.request_zone_override',
    'label', 'Request zone override',
    'description', 'Request a manual zone override with explicit operator reason and approval before shipment zone mutation.',
    'capability', 'baskets.write',
    'schema_category', 'resource:wrong_zone_exceptions',
    'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
    'execution', jsonb_build_object(
      'type', 'rpc',
      'rpc', 'ui_execute_zone_override_request_v1',
      'confirm', jsonb_build_object(
        'title', 'Request manual zone override?',
        'description', 'Submit a reviewed override request instead of automatically reassigning the shipment to the policy zone.',
        'confirm_label', 'Submit override request',
        'cancel_label', 'Cancel',
        'tone', 'default'
      ),
      'input_schema', jsonb_build_object(
        'version', 1,
        'title', 'Zone override request',
        'description', 'Explain why the shipment should stay outside the current basket policy zone and optionally provide a new target zone.',
        'fields', jsonb_build_array(
          jsonb_build_object(
            'key', 'override_reason',
            'label', 'Override reason',
            'type', 'textarea',
            'required', TRUE,
            'placeholder', 'Why should this shipment be manually assigned to a different zone?'
          ),
          jsonb_build_object(
            'key', 'requested_zone_id',
            'label', 'Requested zone ID',
            'type', 'text',
            'required', FALSE,
            'placeholder', 'Leave blank to approve the current basket zone'
          )
        )
      )
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');
      IF v_command_key = 'wrong_zone_exceptions.request_zone_override' THEN
        v_command := public.deep_merge_jsonb(v_canonical_command, v_command);
      END IF;
      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_commands) AS item
      WHERE item->>'key' = 'wrong_zone_exceptions.request_zone_override'
    ) THEN
      v_next_commands := v_next_commands || jsonb_build_array(v_canonical_command);
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Add wrong-zone manual zone override approval command.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604061530_b04_uc062_zone_override_approval_v1'));
COMMIT;
