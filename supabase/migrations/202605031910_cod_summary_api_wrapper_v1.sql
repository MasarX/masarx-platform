-- Console V2 COD summary browser wrapper.
--
-- The canonical public summary helper is service_role-only because it has no
-- auth guard of its own. This API wrapper adds the browser-facing guard before
-- delegating, preserving the public helper's service-only contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605031910_cod_summary_api_wrapper_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.compute_cod_payment_collection_summary_v1(
  p_organization_id UUID,
  p_branch_id UUID DEFAULT NULL,
  p_subject_type TEXT DEFAULT NULL,
  p_subject_id UUID DEFAULT NULL,
  p_window_start_at TIMESTAMPTZ DEFAULT NULL,
  p_window_end_at TIMESTAMPTZ DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_requested_org_id UUID := COALESCE(p_organization_id, v_org_id);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'compute_cod_payment_collection_summary_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('cod.read');

  IF v_requested_org_id IS NULL THEN
    RAISE EXCEPTION 'compute_cod_payment_collection_summary_v1 requires organization scope'
      USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_user() AND v_requested_org_id <> v_org_id THEN
    RAISE EXCEPTION 'compute_cod_payment_collection_summary_v1 cannot read COD summary outside caller organization'
      USING ERRCODE = '42501';
  END IF;

  RETURN public.compute_cod_payment_collection_summary_v1(
    v_requested_org_id,
    p_branch_id,
    p_subject_type,
    p_subject_id,
    p_window_start_at,
    p_window_end_at
  );
END;
$function$;

REVOKE ALL ON FUNCTION api.compute_cod_payment_collection_summary_v1(
  UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.compute_cod_payment_collection_summary_v1(
  UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
) FROM anon;
GRANT EXECUTE ON FUNCTION api.compute_cod_payment_collection_summary_v1(
  UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
) TO authenticated, service_role;

COMMENT ON FUNCTION api.compute_cod_payment_collection_summary_v1(
  UUID, UUID, TEXT, UUID, TIMESTAMPTZ, TIMESTAMPTZ
) IS
  'Browser-safe Console V2 wrapper for canonical COD payment collection summary. Requires cod.read and tenant/platform scope before delegating to the service-only public helper.';

SELECT pg_advisory_unlock(hashtext('202605031910_cod_summary_api_wrapper_v1'));

COMMIT;
