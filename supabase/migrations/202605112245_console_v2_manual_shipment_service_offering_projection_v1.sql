-- Console V2 manual shipment service-offering projection repair.
--
-- Manual shipment creation already resolves the selected service offering and
-- stores its branch/zone/service-level lineage in shipment metadata. Delivery
-- slot and downstream planning contracts need the same lineage projected onto
-- shipment columns so the operator sees usable backend-backed data immediately
-- after create without refresh or side-channel fixes.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605112245_console_v2_manual_shipment_service_offering_projection_v1'));
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

  IF position('branch_id = COALESCE(s.branch_id, v_service_offering_branch_id)' in v_def) > 0 THEN
    v_next := v_def;
  ELSE
    v_next := replace(
      v_def,
$old$cod_currency = COALESCE(v_cod_currency, s.cod_currency),$old$,
$new$cod_currency = COALESCE(v_cod_currency, s.cod_currency),
           branch_id = COALESCE(s.branch_id, v_service_offering_branch_id),
           zone_id = COALESCE(s.zone_id, v_service_offering_zone_id),
           service_level = COALESCE(NULLIF(btrim(COALESCE(s.service_level, '')), ''), v_service_level_key),$new$
    );
    IF v_next = v_def THEN
      RAISE EXCEPTION 'ui_create_shipment_v1 shipment projection patch anchor not found';
    END IF;
  END IF;

  EXECUTE v_next;
END $do$;

REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_create_shipment_v1(UUID, UUID, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605112245_console_v2_manual_shipment_service_offering_projection_v1'));

COMMIT;
