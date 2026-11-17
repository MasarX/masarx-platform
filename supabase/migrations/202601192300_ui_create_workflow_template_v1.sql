-- Migration: UI workflow template creation + step creation RPCs
BEGIN;
SELECT pg_advisory_lock(hashtext('202601192300_ui_create_workflow_template_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_v1(
  p_name TEXT,
  p_description TEXT DEFAULT NULL,
  p_clone_from UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_template_id UUID;
  v_clone_exists BOOLEAN := false;
BEGIN
  IF p_name IS NULL OR btrim(p_name) = '' THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 requires name';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  IF p_clone_from IS NOT NULL THEN
    SELECT TRUE
      INTO v_clone_exists
      FROM public.workflow_templates wt
     WHERE wt.id = p_clone_from
     LIMIT 1;

    IF v_clone_exists IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 clone template not found';
    END IF;
  END IF;

  INSERT INTO public.workflow_templates (
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    created_by
  )
  VALUES (
    btrim(p_name),
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    'draft',
    1,
    v_scope_type,
    v_scope_id,
    auth.uid()
  )
  RETURNING id INTO v_template_id;

  IF p_clone_from IS NOT NULL THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      condition_jsonlogic,
      next_operation_name,
      next_operation_priority,
      next_operation_delay_seconds,
      manual_action_required,
      metadata,
      enabled
    )
    SELECT
      v_template_id,
      step.sequence_order,
      step.operation_name,
      step.operation_settings_category,
      step.transition_condition,
      step.condition_jsonlogic,
      step.next_operation_name,
      step.next_operation_priority,
      step.next_operation_delay_seconds,
      step.manual_action_required,
      step.metadata,
      step.enabled
    FROM public.workflow_template_steps step
    WHERE step.workflow_template_id = p_clone_from
    ORDER BY step.sequence_order ASC;
  END IF;

  RETURN jsonb_build_object(
    'status','ok',
    'workflow_template_id', v_template_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_template_v1(TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_template_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_step_v1(
  p_workflow_template_id UUID,
  p_step JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_operation_name TEXT;
  v_transition_condition TEXT;
  v_handler_key TEXT;
  v_enabled BOOLEAN := TRUE;
  v_manual_action_required BOOLEAN := FALSE;
  v_sequence_order INT;
  v_step_id UUID;
BEGIN
  IF p_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires workflow_template_id';
  END IF;
  IF p_step IS NULL OR jsonb_typeof(p_step) <> 'object' THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires step object';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  v_operation_name := NULLIF(btrim(p_step->>'operation_name'), '');
  v_transition_condition := NULLIF(btrim(p_step->>'transition_condition'), '');
  v_handler_key := NULLIF(btrim(p_step->>'handler_key'), '');

  IF p_step ? 'enabled' THEN
    v_enabled := COALESCE((p_step->>'enabled')::boolean, TRUE);
  END IF;
  IF p_step ? 'manual_action_required' THEN
    v_manual_action_required := COALESCE((p_step->>'manual_action_required')::boolean, FALSE);
  END IF;

  IF v_operation_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires operation_name';
  END IF;
  IF v_transition_condition IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_step_v1 requires transition_condition';
  END IF;

  SELECT COALESCE(MAX(step.sequence_order), 0) + 1
    INTO v_sequence_order
    FROM public.workflow_template_steps step
   WHERE step.workflow_template_id = p_workflow_template_id;

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    handler_key,
    enabled,
    manual_action_required
  )
  VALUES (
    p_workflow_template_id,
    v_sequence_order,
    v_operation_name,
    v_transition_condition,
    v_handler_key,
    v_enabled,
    v_manual_action_required
  )
  RETURNING id INTO v_step_id;

  RETURN jsonb_build_object(
    'status','ok',
    'workflow_template_step_id', v_step_id::text
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_create_workflow_template_step_v1(UUID, JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_template_step_v1(UUID, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202601192300_ui_create_workflow_template_v1'));
COMMIT;

