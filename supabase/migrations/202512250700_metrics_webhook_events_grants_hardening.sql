-- Plan: PLAN-202512-rls-metrics-webhook-events-grants / Step: S04
-- Purpose: metrics_webhook_events is internal SSOT; remove anon/authenticated grants so it is not user-facing.

BEGIN;

SET search_path TO public, pg_temp;

-- Ensure RLS is enabled (idempotent).
ALTER TABLE public.metrics_webhook_events ENABLE ROW LEVEL SECURITY;

-- Least-privilege: keep this table service/edge-only.
REVOKE ALL ON TABLE public.metrics_webhook_events FROM PUBLIC, anon, authenticated;

-- Explicitly grant only what internal roles need.
GRANT SELECT, INSERT ON TABLE public.metrics_webhook_events TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT SELECT, INSERT ON TABLE public.metrics_webhook_events TO edge_label_renderer_role;
  END IF;
END$$;

COMMIT;

