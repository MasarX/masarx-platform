-- Plan: PLAN-202605-console-v2-first-tenant-readiness / Step: P0-import-cancel-reason
-- Migration: Require and persist operator reason for tabular import run cancel.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605130520_tabular_import_cancel_reason_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
  v_reason TEXT;
  v_now TIMESTAMPTZ := now();
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF p_run_id IS NULL THEN
    RAISE EXCEPTION 'ui_cancel_tabular_import_run_v1 requires run id'
      USING ERRCODE = '22023';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_cancel_reason, '')), '');
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

  IF v_run.status IN ('completed', 'completed_with_errors', 'failed', 'canceled') THEN
    RETURN public.ui_get_tabular_import_run_v1(v_run.id);
  END IF;

  UPDATE public.tabular_import_runs
     SET status = 'canceled',
         canceled_at = v_now,
         completed_at = COALESCE(completed_at, v_now),
         summary = jsonb_set(
           COALESCE(summary, '{}'::jsonb) || jsonb_build_object('cancel_reason', v_reason),
           ARRAY['cancellation'],
           COALESCE(summary->'cancellation', '{}'::jsonb)
             || jsonb_strip_nulls(jsonb_build_object(
               'reason', v_reason,
               'canceled_at', v_now,
               'actor_user_id', auth.uid(),
               'correlation_id', v_correlation_id
             )),
           true
         ),
         updated_by = COALESCE(auth.uid(), updated_by),
         updated_at = v_now
   WHERE id = v_run.id;

  UPDATE public.tabular_import_run_rows
     SET execution_status = CASE
                              WHEN execution_status IN ('succeeded', 'failed', 'blocked', 'skipped') THEN execution_status
                              ELSE 'canceled'
                            END,
         processed_at = CASE
                          WHEN execution_status IN ('succeeded', 'failed', 'blocked', 'skipped') THEN processed_at
                          ELSE v_now
                        END,
         updated_at = v_now
   WHERE run_id = v_run.id;

  IF v_run.task_id IS NOT NULL THEN
    PERFORM public.tabular_import_transition_task_system_v1(
      v_run.task_id,
      'canceled',
      'tabular_import_canceled',
      jsonb_strip_nulls(jsonb_build_object('run_id', v_run.id, 'reason', v_reason)),
      'resource_import_studio'
    );
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'decision_category'
       AND lv.value = 'imports.cancel'
  ) THEN
    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
    ) VALUES (
      gen_random_uuid(), v_run.organization_id, 'imports.cancel', 'tabular_import_run', v_run.id,
      'ui_cancel_tabular_import_run_v1', 'cancelled',
      jsonb_strip_nulls(jsonb_build_object(
        'previous_status', v_run.status,
        'reason', v_reason,
        'resource_key', v_run.resource_key
      )),
      'resource_import_studio', v_correlation_id
    );
  END IF;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload,
    correlation_id, status
  ) VALUES (
    v_run.organization_id, 'tabular_import_run.canceled', 'tabular_import_run', v_run.id,
    jsonb_strip_nulls(jsonb_build_object(
      'previous_status', v_run.status,
      'reason', v_reason,
      'resource_key', v_run.resource_key
    )),
    v_correlation_id, 'pending'
  );

  RETURN public.ui_get_tabular_import_run_v1(v_run.id);
END;
$function$;

CREATE OR REPLACE FUNCTION public.ui_cancel_tabular_import_run_v1(
  p_run_id UUID
)
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

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

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

CREATE OR REPLACE FUNCTION api.ui_cancel_tabular_import_run_v1(
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_cancel_tabular_import_run_v1($1);
$function$;

REVOKE ALL ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_cancel_tabular_import_run_v1(UUID) TO authenticated, service_role;

GRANT USAGE ON SCHEMA api TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_cancel_tabular_import_run_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605130520_tabular_import_cancel_reason_v1'));
COMMIT;
