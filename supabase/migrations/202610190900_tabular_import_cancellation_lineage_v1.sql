BEGIN;

SELECT pg_advisory_xact_lock(hashtext('202610190900_tabular_import_cancellation_lineage_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_values (
  lookup_definition_id, value, label, description, sort_order, is_default, status
)
SELECT id, 'imports.cancel', 'Import cancellation',
       'Operator cancellation of a tabular import run', 770, FALSE, 'active'
  FROM public.lookup_definitions
 WHERE category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    status = 'active',
    retired_at = NULL,
    effective_from = NULL,
    effective_until = NULL,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.ui_cancel_tabular_import_run_v1(
  p_run_id UUID,
  p_cancel_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_run public.tabular_import_runs%ROWTYPE;
  v_resource JSONB;
  v_capability TEXT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_cancel_reason, '')), '');
  v_now TIMESTAMPTZ := now();
  v_actor_user_id UUID := auth.uid();
  v_correlation_id UUID;
  v_audit JSONB;
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 requires run id'
      USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_run
    FROM public.tabular_import_runs
   WHERE id = p_run_id
   FOR UPDATE;

  IF v_run.id IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 run % not found', p_run_id
      USING ERRCODE = 'P0002';
  END IF;
  IF NOT public.is_platform_user()
     AND v_run.organization_id IS DISTINCT FROM public.current_user_org_id() THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 cannot cancel another organization'
      USING ERRCODE = '42501';
  END IF;

  v_resource := public.tabular_import_resolve_resource_v1(v_run.resource_key);
  v_capability := COALESCE(
    NULLIF(btrim(COALESCE(v_resource#>>ARRAY['import','capability'], '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_write', '')), ''),
    NULLIF(btrim(COALESCE(v_resource->>'capability_read', '')), ''),
    'system.write'
  );
  PERFORM public.assert_capability_v1(v_capability, 'tenant', v_run.organization_id);

  -- Preserve canonical terminal readback; a late cancel must not rewrite execution history.
  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;

  v_correlation_id := COALESCE(public.current_correlation_id(), gen_random_uuid());
  PERFORM set_config('request.correlation_id', v_correlation_id::text, TRUE);
  v_audit := jsonb_strip_nulls(jsonb_build_object(
    'run_id', v_run.id,
    'previous_status', v_run.status,
    'reason', v_reason,
    'resource_key', v_run.resource_key,
    'actor_user_id', v_actor_user_id,
    'canceled_at', v_now,
    'correlation_id', v_correlation_id
  ));

  UPDATE public.tabular_import_runs
     SET status = 'canceled',
         canceled_at = v_now,
         completed_at = COALESCE(completed_at, v_now),
         summary = COALESCE(summary, '{}'::jsonb) || jsonb_build_object(
           'cancel_reason', v_reason,
           'cancellation', COALESCE(summary->'cancellation', '{}'::jsonb) || v_audit
         ),
         updated_by = COALESCE(v_actor_user_id, updated_by),
         updated_at = v_now
   WHERE id = v_run.id;

  UPDATE public.tabular_import_run_rows
     SET execution_status = 'canceled',
         processed_at = v_now,
         updated_at = v_now
   WHERE run_id = v_run.id
     AND execution_status = 'queued';

  IF v_run.task_id IS NOT NULL THEN
    PERFORM public.tabular_import_transition_task_system_v1(
      v_run.task_id,
      'canceled',
      'tabular_import_canceled',
      v_audit,
      'resource_import_studio'
    );
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, decision_reason,
    performed_by_system, correlation_id
  ) VALUES (
    gen_random_uuid(), v_run.organization_id, 'imports.cancel', 'tabular_import_run', v_run.id,
    'ui_cancel_tabular_import_run_v1', 'cancelled', v_audit, v_reason,
    'resource_import_studio', v_correlation_id
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_run.organization_id, 'tabular_import_run.canceled', 'tabular_import_run', v_run.id,
    v_audit, v_correlation_id, 'pending'
  );

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
END;
$function$;

-- A bounded start batch can leave an unclaimed task with a processing run.
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
    AND r.status IN ('queued', 'processing')
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
  'Service-only claim of open/queued tasks for queued or partially processed imports; active workers are not reclaimed.';

CREATE OR REPLACE FUNCTION public.ui_cancel_tabular_import_run_v1(p_run_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
BEGIN
  RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 requires non-empty cancel reason'
    USING ERRCODE = '22023';
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_cancel_tabular_import_run_v1(
  p_run_id UUID,
  p_cancel_reason TEXT
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_cancel_tabular_import_run_v1($1, $2);
$function$;

CREATE OR REPLACE FUNCTION api.ui_cancel_tabular_import_run_v1(p_run_id UUID)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_cancel_tabular_import_run_v1($1);
$function$;

-- Reinforce the existing service-only wrapper without replacing the worker processor.
CREATE OR REPLACE FUNCTION api.process_tabular_import_run_v1(
  p_run_id UUID,
  p_batch_size INT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.process_tabular_import_run_v1($1, $2);
$function$;

REVOKE ALL ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.process_tabular_import_run_v1(UUID, INT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.process_tabular_import_run_v1(UUID, INT) TO service_role;
REVOKE ALL ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_next_tabular_import_task_v1(TEXT) TO service_role;

COMMIT;
