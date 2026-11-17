-- Migration: Edge label renderer least-privilege role and RPC grants
-- Purpose: Create a dedicated database role for the label-renderer edge function and scope
--          access to required RPC functions only.
-- Date: 2025-11-14

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    CREATE ROLE edge_label_renderer_role NOLOGIN;
  END IF;
END;
$$;

-- Revoke EXECUTE from PUBLIC for sensitive RPCs
REVOKE EXECUTE ON FUNCTION compose_label_payload(UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION lease_label_job(UUID, INTEGER, UUID) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) FROM PUBLIC;

-- Grant EXECUTE to edge role
GRANT EXECUTE ON FUNCTION compose_label_payload(UUID) TO edge_label_renderer_role;
GRANT EXECUTE ON FUNCTION lease_label_job(UUID, INTEGER, UUID) TO edge_label_renderer_role;
GRANT EXECUTE ON FUNCTION complete_label_job(UUID, TEXT, TEXT, INTEGER, JSONB, TEXT) TO edge_label_renderer_role;

-- Inherit via service_role to maintain compatibility with existing service-role keys
GRANT edge_label_renderer_role TO service_role;

COMMIT;

