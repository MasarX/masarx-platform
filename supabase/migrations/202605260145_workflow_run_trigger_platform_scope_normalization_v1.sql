-- Console V2 workflow run triggers: platform operators work through the active
-- tenant lens, but workflow_run_triggers only supports tenant/client/sender
-- scope rows.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605260145_workflow_run_trigger_platform_scope_normalization_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT '{}'::jsonb,
  p_enabled BOOLEAN DEFAULT TRUE,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_scope_type TEXT := public.current_user_scope_type();
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_current_org_id UUID := public.current_user_org_id();
  v_scope_type TEXT := v_actor_scope_type;
  v_scope_id UUID := v_actor_scope_id;
  v_trigger_id UUID;
BEGIN
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_actor_scope_type, v_actor_scope_id);

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'tenant';
    v_scope_id := v_current_org_id;
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
  END IF;

  IF v_scope_type NOT IN ('tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 invalid trigger scope_type %',
      COALESCE(v_scope_type, 'null')
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 trigger scope_id is required'
      USING ERRCODE = '23502';
  END IF;

  INSERT INTO public.workflow_run_triggers (
    scope_type,
    scope_id,
    source_workflow_template_id,
    target_workflow_template_id,
    source_statuses,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    COALESCE(p_source_statuses, ARRAY['completed']::TEXT[]),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_run_trigger_id', v_trigger_id::text
  );
END;
$$;

COMMENT ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT)
  IS 'Creates workflow run triggers through Console V2. Capability: workflows.write. Platform actors are normalized to tenant trigger scope for the active/home org because workflow_run_triggers supports tenant/client/sender only.';

SELECT pg_advisory_unlock(hashtext('202605260145_workflow_run_trigger_platform_scope_normalization_v1'));
COMMIT;
