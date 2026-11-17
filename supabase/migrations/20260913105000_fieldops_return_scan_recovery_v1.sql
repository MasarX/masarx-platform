-- F619 G7: actor-bound accepted scan recovery.
BEGIN;
SELECT pg_advisory_lock(hashtext('20260913105000_fieldops_return_scan_recovery_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
CREATE OR REPLACE FUNCTION public.ui_get_return_to_branch_scan_by_idempotency_v1(p_idempotency_key TEXT)
RETURNS JSONB LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp SET row_security TO on AS $function$
DECLARE
  v_actor UUID := auth.uid();
  v_org UUID := public.current_user_org_id();
  v_scan RECORD;
BEGIN
  IF v_actor IS NULL OR v_org IS NULL THEN
    RAISE EXCEPTION 'return_scan_recovery_forbidden' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL OR btrim(p_idempotency_key) = '' THEN RETURN NULL; END IF;
  SELECT se.id, se.barcode INTO v_scan
  FROM public.scan_event_dedupe d
  JOIN public.scan_events se ON se.id = d.scan_event_id AND se.organization_id = d.organization_id
  WHERE d.organization_id = v_org AND d.idempotency_key = p_idempotency_key
    AND se.actor_user_id = v_actor AND se.scan_type = 'return_to_branch_intake'
  LIMIT 1;
  IF NOT FOUND THEN RETURN NULL; END IF;
  RETURN jsonb_build_object(
    'scan_event_id', v_scan.id, 'barcode', v_scan.barcode,
    'receipt', public.ui_get_return_to_branch_scan_readback_v1(v_scan.id));
END;
$function$;
CREATE OR REPLACE FUNCTION api.ui_get_return_to_branch_scan_by_idempotency_v1(p_idempotency_key TEXT)
RETURNS JSONB LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public, api, extensions, pg_temp AS $function$
  SELECT public.ui_get_return_to_branch_scan_by_idempotency_v1(p_idempotency_key);
$function$;
REVOKE ALL ON FUNCTION public.ui_get_return_to_branch_scan_by_idempotency_v1(TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_get_return_to_branch_scan_by_idempotency_v1(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_get_return_to_branch_scan_by_idempotency_v1(TEXT) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_return_to_branch_scan_by_idempotency_v1(TEXT) TO authenticated;
SELECT pg_advisory_unlock(hashtext('20260913105000_fieldops_return_scan_recovery_v1'));
COMMIT;
