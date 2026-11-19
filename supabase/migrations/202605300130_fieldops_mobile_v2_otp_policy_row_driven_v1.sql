-- FieldOps Mobile V2 stop detail must not infer OTP requirements from
-- service-level literals. Tenant/operator policy rows and stop/shipment
-- metadata are the source of truth; submit_fieldops_proof_v1 remains the
-- fail-closed verifier when OTP is explicitly required.

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.fieldops_v2_stop_otp_required_v1(
  p_shipment_metadata JSONB,
  p_stop_metadata JSONB,
  p_service_level TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (p_stop_metadata->>'otp_required')::boolean,
    (p_shipment_metadata->>'otp_required')::boolean,
    FALSE
  );
$$;

COMMENT ON FUNCTION public.fieldops_v2_stop_otp_required_v1(JSONB, JSONB, TEXT)
  IS 'Resolves FieldOps Mobile V2 stop OTP requirement from explicit stop/shipment metadata only; service-level-specific OTP policy belongs in policy/config rows, not code literals.';

REVOKE ALL ON FUNCTION public.fieldops_v2_stop_otp_required_v1(JSONB, JSONB, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_stop_otp_required_v1(JSONB, JSONB, TEXT) TO authenticated, service_role;
