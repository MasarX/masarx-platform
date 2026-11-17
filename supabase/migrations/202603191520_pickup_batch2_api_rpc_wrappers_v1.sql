-- Plan: B02 Pickup & first-mile handoff
-- Migration: Pickup batch 2 api rpc wrappers v1
-- Date: 2026-03-19
--
-- Purpose:
--   - Expose pickup mutation RPCs through the canonical api schema so Console and
--     Portal server actions can keep using the default UI schema contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603191520_pickup_batch2_api_rpc_wrappers_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE FUNCTION api.create_pickup_request_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
  SELECT public.create_pickup_request_v1(p_input);
$$;

CREATE OR REPLACE FUNCTION api.create_pickup_wave_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
  SELECT public.create_pickup_wave_v1(p_input);
$$;

CREATE OR REPLACE FUNCTION api.assign_pickup_wave_v1(p_input JSONB)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $$
  SELECT public.assign_pickup_wave_v1(p_input);
$$;

REVOKE ALL ON FUNCTION api.create_pickup_request_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.create_pickup_wave_v1(JSONB) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION api.assign_pickup_wave_v1(JSONB) FROM PUBLIC, anon, authenticated;

GRANT EXECUTE ON FUNCTION api.create_pickup_request_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.create_pickup_wave_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.assign_pickup_wave_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603191520_pickup_batch2_api_rpc_wrappers_v1'));
COMMIT;
