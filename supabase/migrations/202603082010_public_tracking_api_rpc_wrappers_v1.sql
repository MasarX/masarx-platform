BEGIN;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.public_tracking_lookup_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.public_tracking_lookup_v1(p_input);
$$;

CREATE OR REPLACE FUNCTION api.public_tracking_verify_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.public_tracking_verify_v1(p_input);
$$;

CREATE OR REPLACE FUNCTION api.public_tracking_session_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.public_tracking_session_v1(p_input);
$$;

CREATE OR REPLACE FUNCTION api.public_tracking_create_request_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.public_tracking_create_request_v1(p_input);
$$;

REVOKE ALL ON FUNCTION api.public_tracking_lookup_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.public_tracking_verify_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.public_tracking_session_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.public_tracking_create_request_v1(JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION api.public_tracking_lookup_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_verify_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_session_v1(JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION api.public_tracking_create_request_v1(JSONB) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_lookup_v1(JSONB) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_verify_v1(JSONB) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_session_v1(JSONB) TO edge_api_gateway_role;
    GRANT EXECUTE ON FUNCTION api.public_tracking_create_request_v1(JSONB) TO edge_api_gateway_role;
  END IF;
END $$;

COMMIT;
