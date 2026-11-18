-- Console V2 manual shipment active-sender guard.
--
-- Shipment intake must not accept inactive/suspended senders. The frontend now
-- hides inactive senders from the composer; this backend guard keeps the
-- canonical UI shipment create RPC fail-closed for bypass, stale UI, and API
-- wrapper callers.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605152345_console_v2_manual_shipment_active_sender_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_def TEXT;
  v_next TEXT;
BEGIN
  SELECT pg_get_functiondef(
    'public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB)'::regprocedure
  )
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ui_create_shipment_v1 function is missing';
  END IF;

  IF v_def LIKE '%ui_create_shipment_v1 sender is inactive%' THEN
    RAISE NOTICE 'ui_create_shipment_v1 already guards inactive senders';
    RETURN;
  END IF;

  v_next := replace(
    v_def,
$old$
  v_sender_client_id UUID;
  v_sender_org_id UUID;
  v_service_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'delivery');
$old$,
$new$
  v_sender_client_id UUID;
  v_sender_org_id UUID;
  v_sender_status TEXT;
  v_service_type TEXT := COALESCE(NULLIF(btrim(COALESCE(p_service_type, '')), ''), 'delivery');
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 sender declaration patch anchor not found';
  END IF;
  v_def := v_next;

  v_next := replace(
    v_def,
$old$
    SELECT s.client_id, c.organization_id
      INTO v_sender_client_id, v_sender_org_id
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id
     LIMIT 1;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender not found';
    END IF;
    IF v_sender_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is outside the current organization';
    END IF;
$old$,
$new$
    SELECT s.client_id, c.organization_id, s.status
      INTO v_sender_client_id, v_sender_org_id, v_sender_status
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_sender_id
     LIMIT 1;

    IF v_sender_client_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender not found';
    END IF;
    IF lower(COALESCE(v_sender_status, 'active')) <> 'active' THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is inactive'
        USING ERRCODE = '42501';
    END IF;
    IF v_sender_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 sender is outside the current organization';
    END IF;
$new$
  );
  IF v_next = v_def THEN
    RAISE EXCEPTION 'ui_create_shipment_v1 sender status patch anchor not found';
  END IF;

  EXECUTE v_next;
END $do$;

REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605152345_console_v2_manual_shipment_active_sender_guard_v1'));

COMMIT;
