-- Restore tenant signup review hardening after later implementation replacement.
-- The public/api wrappers remain the only callable service entrypoints.

BEGIN;

SET search_path TO public, extensions, pg_temp;

SELECT pg_advisory_lock(hashtext('202606042128_tenant_signup_private_impl_execute_lockdown_v1'));

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) FROM PUBLIC;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) FROM anon;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) FROM authenticated;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) FROM service_role;

REVOKE ALL ON FUNCTION public.tenant_signup_review_apply_v1_impl_202605031930(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) FROM edge_api_gateway_role;

GRANT EXECUTE ON FUNCTION public.tenant_signup_review_apply_v1(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) TO service_role, edge_api_gateway_role;

GRANT EXECUTE ON FUNCTION api.tenant_signup_review_apply_v1(
  UUID,
  TEXT,
  UUID,
  TEXT,
  UUID,
  BOOLEAN,
  TEXT,
  JSONB
) TO service_role, edge_api_gateway_role;

SELECT pg_advisory_unlock(hashtext('202606042128_tenant_signup_private_impl_execute_lockdown_v1'));

COMMIT;
