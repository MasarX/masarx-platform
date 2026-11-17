-- Plan: PLAN-202603-shared-mapping-studio / Step: S05
-- Migration: Allow tabular import worker claims on canonical open tasks
--
-- Purpose:
--   - Align claim_next_tabular_import_task_v1 with create_task_v1 semantics.
--   - Tabular import tasks are created in the canonical "open" state; the
--     worker must claim those tasks instead of waiting for a non-existent
--     "queued" task status.

BEGIN;

SELECT pg_advisory_lock(hashtext('202603091290_tabular_import_claim_open_tasks_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.claim_next_tabular_import_task_v1(
  p_worker_id TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_task RECORD;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN OTHERS THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF COALESCE(v_role, '') NOT IN ('service_role', 'supabase_admin') AND current_user <> 'postgres' THEN
    RAISE EXCEPTION 'claim_next_tabular_import_task_v1 requires service role context'
      USING ERRCODE = '42501';
  END IF;

  SELECT
    t.id AS task_id,
    t.organization_id,
    t.resource_id AS run_id,
    t.queue_key,
    r.resource_key,
    r.write_mode,
    r.summary
  INTO v_task
  FROM public.tasks t
  JOIN public.task_types tt ON tt.id = t.task_type_id
  JOIN public.tabular_import_runs r ON r.id = t.resource_id
  WHERE tt.key = 'tabular_import.process'
    AND t.resource_type = 'tabular_import_run'
    AND t.status IN ('open', 'queued')
    AND r.status = 'queued'
  ORDER BY t.priority DESC, t.created_at ASC
  FOR UPDATE OF t, r SKIP LOCKED
  LIMIT 1;

  IF v_task.task_id IS NULL THEN
    RETURN NULL;
  END IF;

  PERFORM public.tabular_import_transition_task_system_v1(
    v_task.task_id,
    'in_progress',
    'tabular_import_claimed',
    jsonb_strip_nulls(jsonb_build_object('worker_id', NULLIF(btrim(COALESCE(p_worker_id, '')), ''))),
    'tabular_import_worker'
  );

  UPDATE public.tabular_import_runs
     SET status = 'processing',
         started_at = COALESCE(started_at, now()),
         updated_at = now()
   WHERE id = v_task.run_id;

  RETURN jsonb_build_object(
    'task_id', v_task.task_id,
    'run_id', v_task.run_id,
    'organization_id', v_task.organization_id,
    'resource_key', v_task.resource_key,
    'write_mode', v_task.write_mode,
    'queue_key', v_task.queue_key,
    'worker_id', NULLIF(btrim(COALESCE(p_worker_id, '')), ''),
    'summary', COALESCE(v_task.summary, '{}'::jsonb)
  );
END;
$function$;

COMMENT ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) IS
  'Service-only worker claim RPC for queued tabular import runs backed by canonical open task rows.';

REVOKE ALL ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091290_tabular_import_claim_open_tasks_v1'));

COMMIT;
