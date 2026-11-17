-- Plan: PLAN-202512-api-gateway-logestechs-v2-mirror / Step: S04
-- Migration: Edge API gateway role (least privilege)
-- Purpose: Restrict api-gateway edge function DB access to the single intake RPC.
-- Date: 2025-12-25

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_api_gateway_role') THEN
    CREATE ROLE edge_api_gateway_role NOLOGIN NOINHERIT;
  END IF;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM authenticated;

GRANT USAGE ON SCHEMA public TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO edge_api_gateway_role;

GRANT edge_api_gateway_role TO service_role;

COMMIT;
