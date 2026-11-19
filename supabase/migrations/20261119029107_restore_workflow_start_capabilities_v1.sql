BEGIN;
SET LOCAL lock_timeout = '10s';

-- Enforce each active start policy before domain payload validation or workflow insertion.
DO $patch$
DECLARE
  v_definition TEXT := pg_get_functiondef('public.ui_start_workflow_run_v1(uuid,jsonb,boolean)'::regprocedure);
  v_variables TEXT := $old$  v_run_id UUID;$old$;
  v_payload_guard TEXT := '  PERFORM public.assert_workflow_start_payload_policy_v1(';
  v_capabilities TEXT := $guard$  FOR v_policy IN
    SELECT required_capability, scope_type
    FROM public.workflow_template_start_policy
    WHERE workflow_template_id = p_workflow_template_id AND is_active IS TRUE
    ORDER BY required_capability
  LOOP
    PERFORM public.assert_capability_v1(
      v_policy.required_capability,
      COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type),
      CASE
        WHEN COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type) = v_scope_type THEN v_scope_id
        WHEN v_policy.scope_type = 'tenant' THEN public.current_user_org_id()
        ELSE v_scope_id
      END
    );
  END LOOP;

$guard$;
BEGIN
  IF position(v_variables IN v_definition) = 0 OR position(v_payload_guard IN v_definition) = 0 THEN
    RAISE EXCEPTION 'Workflow start admission boundary changed';
  END IF;
  EXECUTE replace(replace(v_definition, v_variables, v_variables || E'\n  v_policy RECORD;'),
    v_payload_guard, v_capabilities || v_payload_guard);
END;
$patch$;

COMMIT;
