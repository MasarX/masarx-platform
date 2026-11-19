-- Migration: FieldOps Mobile V2 stop-detail contact metadata readback
-- Purpose:
--   Project backend-backed customer phone from existing route-stop contact
--   metadata when the base stop-detail resolver has no recipient phone.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606061120_fieldops_stop_detail_contact_metadata_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
BEGIN
  IF to_regprocedure('public.resolve_fieldops_stop_detail_contact_base_v1(uuid,text,jsonb)') IS NULL
     AND to_regprocedure('public.resolve_fieldops_stop_detail_v1(uuid,text,jsonb)') IS NOT NULL THEN
    ALTER FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB)
      RENAME TO resolve_fieldops_stop_detail_contact_base_v1;
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_envelope JSONB;
  v_contact_metadata JSONB;
  v_customer_phone TEXT;
BEGIN
  v_envelope := public.resolve_fieldops_stop_detail_contact_base_v1(p_stop_id, p_active_role, p_context);

  IF NULLIF(v_envelope->>'customerPhone', '') IS NULL THEN
    v_contact_metadata := public.route_stop_task_contact_metadata_v1(p_stop_id);
    v_customer_phone := COALESCE(
      NULLIF(btrim(v_contact_metadata #>> '{customer,phone_number}'), ''),
      NULLIF(btrim(v_contact_metadata #>> '{contact,phone_number}'), '')
    );

    IF v_customer_phone IS NOT NULL THEN
      v_envelope := jsonb_set(v_envelope, '{customerPhone}', to_jsonb(v_customer_phone), TRUE);
    END IF;
  END IF;

  RETURN v_envelope;
END;
$$;

COMMENT ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) IS
  'Mobile V2 stop-detail readback wrapper. Preserves canonical stop-detail behavior and fills customerPhone from route_stop_task_contact_metadata_v1 when shipment metadata carries backend contact truth but recipient phone is absent.';

REVOKE ALL ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_fieldops_stop_detail_v1(
  p_stop_id UUID,
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_fieldops_stop_detail_v1(p_stop_id, p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.resolve_fieldops_stop_detail_v1(UUID, TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202606061120_fieldops_stop_detail_contact_metadata_readback_v1'));
COMMIT;
