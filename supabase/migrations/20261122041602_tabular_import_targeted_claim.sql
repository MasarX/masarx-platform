BEGIN;
SET LOCAL lock_timeout = '30s';

CREATE FUNCTION public.claim_tabular_import_task_internal_v1(
  p_worker_id TEXT,
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY INVOKER
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
    RAISE EXCEPTION 'claim_tabular_import_task_internal_v1 requires service role context'
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
    AND r.status IN ('queued', 'processing')
    AND (p_run_id IS NULL OR (
      r.id = p_run_id AND r.task_id = t.id AND r.organization_id = t.organization_id
    ))
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

REVOKE ALL ON FUNCTION public.claim_tabular_import_task_internal_v1(TEXT, UUID)
  FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.claim_next_tabular_import_task_v1(p_worker_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.claim_tabular_import_task_internal_v1(p_worker_id, NULL);
$function$;

CREATE FUNCTION public.claim_tabular_import_task_v1(p_run_id UUID, p_worker_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'A run ID is required' USING ERRCODE = '22004';
  END IF;
  RETURN public.claim_tabular_import_task_internal_v1(p_worker_id, p_run_id);
END;
$function$;

CREATE FUNCTION api.claim_tabular_import_task_v1(p_run_id UUID, p_worker_id TEXT DEFAULT NULL)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.claim_tabular_import_task_v1(p_run_id, p_worker_id);
$function$;

REVOKE ALL ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_tabular_import_task_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.claim_tabular_import_task_v1(UUID, TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_tabular_import_task_v1(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION api.claim_tabular_import_task_v1(UUID, TEXT) TO service_role;

COMMIT;
