BEGIN;

SELECT pg_advisory_lock(hashtext('202604031910_scan_events_tenant_scope_order_fix_v1'));

DO $mig$
DECLARE
  v_function_def text;
  v_current_guard text := $current$  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN$current$;
  v_desired_guard text := $desired$  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_scan_event_v1 could not resolve organization_id';
  END IF;
  IF NOT public.is_platform_user()
    AND public.current_user_scope_type() IS DISTINCT FROM 'tenant'
  THEN
    RAISE EXCEPTION 'record_scan_event_v1 requires tenant scope' USING ERRCODE = '42501';
  END IF;
  IF jsonb_typeof(v_in) <> 'object' THEN$desired$;
BEGIN
  SELECT pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    INTO v_function_def;

  IF position(v_desired_guard in v_function_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_current_guard in v_function_def) = 0 THEN
    RAISE EXCEPTION
      'Unexpected record_scan_event_v1 definition shape while fixing tenant scope guard order';
  END IF;

  v_function_def := replace(v_function_def, v_current_guard, v_desired_guard);
  EXECUTE v_function_def;
END;
$mig$;

SELECT pg_advisory_unlock(hashtext('202604031910_scan_events_tenant_scope_order_fix_v1'));

COMMIT;
