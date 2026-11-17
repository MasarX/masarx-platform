-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Ensure feature_flags exists (restore after cleanup)
-- Purpose:
--   - feature_flags is part of configuration core and is referenced by audit/table-contract
--     reconciliation steps in CI (ensure_audit_triggers/apply_table_contracts).
--   - Some preview projects may have dropped this table during cleanup; this migration
--     restores the canonical table contract in an idempotent, non-destructive way.
BEGIN;
SET search_path TO public, extensions, pg_temp;

CREATE TABLE IF NOT EXISTS public.feature_flags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL UNIQUE,
  description TEXT,
  scope_type TEXT NOT NULL,
  scope_id UUID,
  enabled BOOLEAN NOT NULL DEFAULT false,
  rollout_percentage INTEGER NOT NULL DEFAULT 0,
  conditions JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feature_flags_rollout_percentage_check CHECK (rollout_percentage BETWEEN 0 AND 100)
);

CREATE INDEX IF NOT EXISTS idx_feature_flags_scope
  ON public.feature_flags(scope_type, scope_id);

CREATE INDEX IF NOT EXISTS idx_feature_flags_enabled
  ON public.feature_flags(enabled)
  WHERE enabled = true;

COMMENT ON TABLE public.feature_flags IS 'Feature toggle system for gradual rollout and A/B testing';
COMMENT ON COLUMN public.feature_flags.scope_type IS 'Lookup category: feature_flag_scope (global, tenant, client)';
COMMENT ON COLUMN public.feature_flags.rollout_percentage IS 'Gradual rollout percentage (0-100)';
COMMENT ON COLUMN public.feature_flags.conditions IS 'Additional JSONLogic rules for feature activation';

-- Enforce least-privileged access (internal-only table).
ALTER TABLE public.feature_flags ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feature_flags FROM PUBLIC;
REVOKE ALL ON TABLE public.feature_flags FROM anon;
REVOKE ALL ON TABLE public.feature_flags FROM authenticated;

DROP POLICY IF EXISTS feature_flags_service_policy ON public.feature_flags;
CREATE POLICY feature_flags_service_policy
  ON public.feature_flags
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMIT;
