-- Console V2 browser-safe wrapper for progressing a workflow until it reaches
-- the next waiting state. Needed by Review queue human task completions so
-- follow-on tasks become visible without a browser reload.

BEGIN;

CREATE OR REPLACE FUNCTION api.progress_workflow_run_until_wait_v1(
  p_workflow_run_id uuid,
  p_input jsonb DEFAULT '{}'::jsonb,
  p_budget_ms integer DEFAULT 5000,
  p_max_steps integer DEFAULT 8
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'workflow_handlers', 'extensions', 'pg_temp'
AS $function$
DECLARE
  v_visible_run jsonb;
  v_prev_actor_system text := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claim_role text := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_claims_text text := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_claims jsonb := '{}'::jsonb;
  v_service_claims jsonb := '{"role":"service_role"}'::jsonb;
  v_result jsonb;
BEGIN
  IF p_workflow_run_id IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_until_wait_v1 requires workflow_run_id';
  END IF;

  -- Keep the wrapper browser-safe: the authenticated operator must be able to
  -- read the run before the server-side workflow engine is allowed to advance it.
  v_visible_run := public.ui_get_resource_v1('workflow_runs', p_workflow_run_id);
  IF v_visible_run IS NULL THEN
    RAISE EXCEPTION 'progress_workflow_run_until_wait_v1 workflow run not visible';
  END IF;

  BEGIN
    v_prev_claims := NULLIF(v_prev_claims_text, '')::jsonb;
  EXCEPTION WHEN others THEN
    v_prev_claims := '{}'::jsonb;
  END;
  IF jsonb_typeof(v_prev_claims) <> 'object' THEN
    v_prev_claims := '{}'::jsonb;
  END IF;
  v_service_claims := jsonb_set(v_prev_claims, '{role}', to_jsonb('service_role'::text), true);

  PERFORM set_config('app.actor_system', 'workflow_engine', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  v_result := public.progress_workflow_run_until_wait_v1(
    p_workflow_run_id,
    COALESCE(p_input, '{}'::jsonb),
    COALESCE(p_budget_ms, 5000),
    COALESCE(p_max_steps, 8)
  );

  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_claim_role, true);
  PERFORM set_config('request.jwt.claims', v_prev_claims_text, true);

  RETURN v_result;
EXCEPTION WHEN others THEN
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_claim_role, true);
  PERFORM set_config('request.jwt.claims', v_prev_claims_text, true);
  RAISE;
END;
$function$;

COMMENT ON FUNCTION api.progress_workflow_run_until_wait_v1(uuid, jsonb, integer, integer)
  IS 'Browser-safe API wrapper for public.progress_workflow_run_until_wait_v1. Used by Console V2 Review queue after human task completion to reconcile follow-on workflow tasks without reload.';

REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(uuid, jsonb, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.progress_workflow_run_until_wait_v1(uuid, jsonb, integer, integer) FROM anon;
GRANT EXECUTE ON FUNCTION api.progress_workflow_run_until_wait_v1(uuid, jsonb, integer, integer) TO authenticated, service_role;

COMMIT;
