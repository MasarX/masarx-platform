-- Migration: api wrapper for lease_and_compose_label_payloads_compact
-- Purpose:
--  - Expose compact lease+compose RPC via api schema so PostgREST rpc callers can resolve it.
--  - Preserve least-privilege grants for service and edge renderer roles.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;

CREATE OR REPLACE FUNCTION api.lease_and_compose_label_payloads_compact(
  p_job_ids UUID[],
  p_lease_seconds INTEGER DEFAULT 300,
  p_max_jobs INTEGER DEFAULT 10
)
RETURNS TABLE (
  job_id UUID,
  composed JSONB,
  compose_ms NUMERIC
)
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.lease_and_compose_label_payloads_compact(
    p_job_ids,
    p_lease_seconds,
    p_max_jobs
  );
$function$;

COMMENT ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER)
  IS 'API schema wrapper for compact all-or-none lease+compose label payloads RPC.';

REVOKE ALL ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM anon;
REVOKE ALL ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) FROM authenticated;

GRANT USAGE ON SCHEMA api TO service_role;
GRANT EXECUTE ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT USAGE ON SCHEMA api TO edge_label_renderer_role;
    GRANT EXECUTE ON FUNCTION api.lease_and_compose_label_payloads_compact(UUID[], INTEGER, INTEGER)
      TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;
