-- Console V2 first-tenant readiness: workflow run cancel must work from the
-- browser-safe API wrapper under authenticated RLS.
BEGIN;
SELECT pg_advisory_lock(hashtext('202605231930_workflow_run_close_security_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.close_workflow_run(
  p_workflow_run_id UUID,
  p_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_status TEXT := lower(NULLIF(btrim(COALESCE(p_status, '')), ''));
  v_claim_role TEXT := lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''));
  v_claims JSONB := COALESCE(NULLIF(current_setting('request.jwt.claims', true), '')::jsonb, '{}'::jsonb);
  v_effective_role TEXT := COALESCE(v_claim_role, lower(NULLIF(v_claims->>'role', '')), '');
  v_scope_type TEXT;
  v_scope_id UUID;
  v_org_id UUID;
  v_run RECORD;
  v_updated INTEGER;
  v_step_status TEXT;
BEGIN
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'close_workflow_run requires a terminal status'
      USING ERRCODE = '22023';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'workflow_run_status'
       AND lv.value = v_status
       AND COALESCE(lv.status, 'active') = 'active'
  ) THEN
    RAISE EXCEPTION 'close_workflow_run invalid workflow status: %', v_status
      USING ERRCODE = '22023';
  END IF;

  SELECT
    wr.id,
    wr.workflow_status,
    wr.context,
    wt.scope_type AS template_scope_type,
    wt.scope_id AS template_scope_id
  INTO v_run
  FROM public.workflow_runs wr
  LEFT JOIN public.workflow_templates wt
    ON wt.id = wr.workflow_template_id
  WHERE wr.id = p_workflow_run_id
  FOR UPDATE OF wr;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'close_workflow_run workflow run not found: %', p_workflow_run_id
      USING ERRCODE = 'P0002';
  END IF;

  IF v_run.workflow_status IN ('completed', 'failed', 'cancelled', 'canceled', 'succeeded', 'timeout', 'timed_out', 'stopped', 'skipped') THEN
    IF v_run.workflow_status = v_status THEN
      RETURN;
    END IF;

    RAISE EXCEPTION 'close_workflow_run cannot change terminal workflow status % to %', v_run.workflow_status, v_status
      USING ERRCODE = '25006';
  END IF;

  IF v_effective_role <> 'service_role' THEN
    v_scope_type := public.current_user_scope_type();
    v_scope_id := public.current_user_scope_id();
    v_org_id := public.current_user_org_id();

    PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

    IF v_scope_type IS DISTINCT FROM 'platform' THEN
      IF COALESCE(
           NULLIF(v_run.context->>'organization_id', '')::uuid,
           CASE WHEN v_run.template_scope_type = 'tenant' THEN v_run.template_scope_id END
         ) IS DISTINCT FROM v_org_id THEN
        RAISE EXCEPTION 'close_workflow_run workflow run not visible'
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  UPDATE public.workflow_runs
     SET workflow_status = v_status,
         completed_at = COALESCE(completed_at, now()),
         updated_at = now(),
         version = COALESCE(version, 1) + 1
   WHERE id = p_workflow_run_id
     AND workflow_status NOT IN ('completed', 'failed', 'cancelled', 'canceled', 'succeeded', 'timeout', 'timed_out', 'stopped', 'skipped');

  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 1 THEN
    RAISE EXCEPTION 'close_workflow_run update failed for %', p_workflow_run_id
      USING ERRCODE = 'P0001';
  END IF;

  IF v_status IN ('cancelled', 'canceled', 'failed', 'timeout', 'timed_out', 'stopped') THEN
    SELECT lv.value
      INTO v_step_status
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld
        ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'workflow_step_status'
       AND lv.value = v_status
       AND COALESCE(lv.status, 'active') = 'active'
     LIMIT 1;

    IF v_step_status IS NULL AND v_status IN ('failed', 'timeout', 'timed_out') THEN
      v_step_status := 'failed';
    ELSIF v_step_status IS NULL THEN
      v_step_status := 'skipped';
    END IF;

    UPDATE public.workflow_run_steps
       SET step_status = v_step_status,
           operation_completed_at = CASE
             WHEN step_status IN ('pending', 'in_progress', 'running') THEN COALESCE(operation_completed_at, now())
             ELSE operation_completed_at
           END,
           updated_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object(
             'closed_by_workflow_run_status',
             v_status
           )
     WHERE workflow_run_id = p_workflow_run_id
       AND step_status IN ('pending', 'in_progress', 'running');
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.close_workflow_run(UUID, TEXT)
  IS 'Mark a workflow run terminal through the canonical workflow close path. Authenticated callers require workflow_runs.write and scoped visibility; service_role remains available for engine-owned closeout.';

REVOKE ALL ON FUNCTION public.close_workflow_run(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.close_workflow_run(UUID, TEXT) FROM anon;
GRANT EXECUTE ON FUNCTION public.close_workflow_run(UUID, TEXT) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605231930_workflow_run_close_security_definer_v1'));
COMMIT;
