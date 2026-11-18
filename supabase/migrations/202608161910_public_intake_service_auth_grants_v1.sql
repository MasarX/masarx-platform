-- Public intake mutations are service-only; remove obsolete edge-role grants.
BEGIN;
SET search_path TO public, extensions, pg_temp;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    REVOKE EXECUTE ON FUNCTION api.marketing_lead_request_create_v1(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
    ) FROM edge_api_gateway_role;
    REVOKE EXECUTE ON FUNCTION api.marketing_demo_request_create_v1(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
    ) FROM edge_api_gateway_role;
    REVOKE EXECUTE ON FUNCTION public.marketing_demo_request_create_v1(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
    ) FROM edge_api_gateway_role;
    REVOKE EXECUTE ON FUNCTION api.tenant_signup_policy_v1()
      FROM edge_api_gateway_role;
    REVOKE EXECUTE ON FUNCTION api.tenant_signup_request_create_v1(
      TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN
    ) FROM edge_api_gateway_role;
  END IF;
END;
$$;

COMMIT;
