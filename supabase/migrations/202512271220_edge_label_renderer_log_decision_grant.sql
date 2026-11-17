-- Migration: Grant log_decision access to edge_label_renderer_role
-- Purpose:
--   - Allow label renderer edge worker to write decision_log via SECURITY DEFINER helper.
--   - Keep least-privilege grants scoped to the required function signature.
-- Alignment: SIMPLE - SCALABLE - SSOT.
-- Date: 2025-12-27

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    REVOKE EXECUTE ON FUNCTION public.log_decision(
      UUID,
      TEXT,
      TEXT,
      UUID,
      TEXT,
      TEXT,
      TEXT,
      UUID,
      JSONB,
      TEXT,
      UUID
    ) FROM PUBLIC;

    GRANT EXECUTE ON FUNCTION public.log_decision(
      UUID,
      TEXT,
      TEXT,
      UUID,
      TEXT,
      TEXT,
      TEXT,
      UUID,
      JSONB,
      TEXT,
      UUID
    ) TO edge_label_renderer_role;
  END IF;
END;
$$;

COMMIT;
