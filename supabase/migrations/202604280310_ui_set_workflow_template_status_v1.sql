-- Spec-Issue: Phase B6 - Workflow RPC contract: ui_set_workflow_template_status_v1
-- Step: B6-RPC-22
-- Capability: workflows.write
--
-- Behavior: forcibly sets public.workflow_templates.status to a target value
-- (one of {'draft','active','inactive','retired'}). Records audit row on the
-- canonical lifecycle ledger and writes decision_log + domain_events for the
-- transition so downstream observers (settings-ladder consumers, dispatch
-- audit) can see the lifecycle change.
--
-- Closes WORKFLOWS Wave 5 v2 P0 #1 (FE caller existed in console-v2 with no
-- backend migration; production calls resolved to "function does not exist").

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280310_ui_set_workflow_template_status_v1'));
SET search_path TO public, extensions, pg_temp;

-- =============================================================================
-- Foundation: workflow_template_status_changes audit ledger
-- =============================================================================
--
-- One row per status transition for the canonical workflow_templates table.
-- Service-only (RLS enabled, no policies for authenticated/anon — the FE reads
-- through ui_read_registry-style projections, not direct table access).
-- objectives:allow POLICY_MISSING Justification: service-only audit ledger is written by SECURITY DEFINER RPCs and intentionally has no direct authenticated/anon table policies.
CREATE TABLE IF NOT EXISTS public.workflow_template_status_changes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID,
  workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  prior_status TEXT,
  next_status TEXT NOT NULL,
  reason TEXT,
  changed_by UUID,
  correlation_id TEXT,
  decision_log_id UUID,
  changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_workflow_template_status_changes_template
  ON public.workflow_template_status_changes(workflow_template_id, changed_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_template_status_changes_org
  ON public.workflow_template_status_changes(organization_id, changed_at DESC);

ALTER TABLE public.workflow_template_status_changes ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE public.workflow_template_status_changes IS
  'Service-only audit ledger: status transitions for public.workflow_templates. RLS enabled; no authenticated/anon grants.';

-- =============================================================================
-- RPC: ui_set_workflow_template_status_v1
-- =============================================================================
CREATE OR REPLACE FUNCTION public.ui_set_workflow_template_status_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_template_id UUID := NULLIF(p_args->>'template_id', '')::uuid;
  v_target_status TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'status', '')), ''));
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.workflow_templates%ROWTYPE;
  v_template_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires template_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_target_status IS NULL OR v_target_status NOT IN ('draft', 'active', 'inactive', 'retired') THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 invalid status %', v_target_status
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO v_before
    FROM public.workflow_templates
   WHERE id = v_template_id
   FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 workflow_template % not found', v_template_id
      USING ERRCODE = '23503';
  END IF;

  -- Enforce tenant scoping: when the template carries a tenant scope_id, the
  -- caller must belong to that tenant (platform users are exempt).
  v_template_org := CASE WHEN v_before.scope_type = 'tenant' THEN v_before.scope_id ELSE NULL END;
  IF v_org_id IS NOT NULL
     AND v_template_org IS NOT NULL
     AND v_template_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 workflow_template % outside tenant scope', v_template_id
      USING ERRCODE = '42501';
  END IF;

  -- Apply the status transition. published_at / retired_at are tracked on
  -- the canonical workflow_templates table (see 202510110005_communications.sql).
  UPDATE public.workflow_templates
     SET status = v_target_status,
         published_at = CASE
           WHEN v_target_status = 'active' AND published_at IS NULL THEN now()
           ELSE published_at
         END,
         retired_at = CASE
           WHEN v_target_status = 'retired' THEN now()
           ELSE retired_at
         END
   WHERE id = v_template_id;

  -- Audit ledger row.
  INSERT INTO public.workflow_template_status_changes (
    organization_id, workflow_template_id, prior_status, next_status,
    reason, changed_by, correlation_id, decision_log_id
  ) VALUES (
    COALESCE(v_template_org, v_org_id), v_template_id, v_before.status, v_target_status,
    v_reason, v_user_id, v_correlation_id, v_decision_id
  );

  -- Decision-log entry for the lifecycle transition.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_template_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.template_status', 'workflow_template', v_template_id,
    'ui_set_workflow_template_status_v1', v_target_status,
    jsonb_strip_nulls(jsonb_build_object(
      'prior_status', v_before.status,
      'next_status', v_target_status,
      'reason', v_reason
    )),
    'ui_set_workflow_template_status_v1', v_correlation_id::uuid
  );

  -- Surface the change to downstream observers via domain_events (when the
  -- template carries an org scope so the event is tenant-attributable).
  IF COALESCE(v_template_org, v_org_id) IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_template_org, v_org_id),
      'workflow_template.status_changed', 'workflow_template', v_template_id,
      jsonb_build_object(
        'prior_status', v_before.status,
        'next_status', v_target_status
      ),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_template_id', v_template_id,
    'prior_status', v_before.status,
    'next_status', v_target_status,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_set_workflow_template_status_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_set_workflow_template_status_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_set_workflow_template_status_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ui_set_workflow_template_status_v1(jsonb)
  IS 'Canonical write RPC: sets public.workflow_templates.status (draft/active/inactive/retired) + audit row + decision_log + domain_event. Capability: workflows.write.';

SELECT pg_advisory_unlock(hashtext('202604280310_ui_set_workflow_template_status_v1'));
COMMIT;
