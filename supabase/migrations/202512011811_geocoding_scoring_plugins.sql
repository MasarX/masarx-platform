-- Migration: Geocoding scoring plugins + decision log enrichment (stubs)
-- Purpose: Install helper schemas for pluginized scoring (perfect/fuzzy/long_line/reverse) and extend decision_log payload.
-- Note: Business logic will be implemented in application layer/handlers; this migration adds enums, tables, and logging columns only.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- Enum for match plugin names.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'geocoding_match_plugin') THEN
    CREATE TYPE geocoding_match_plugin AS ENUM ('perfect', 'fuzzy', 'long_line', 'reverse');
  END IF;
END;
$$;

-- Extend decision_log metadata to carry scoring details (JSONB, SSOT).
ALTER TABLE decision_log
  ADD COLUMN IF NOT EXISTS geocoding_match JSONB;

COMMENT ON COLUMN decision_log.geocoding_match IS 'Scoring details for geocoding decisions: {plugin, score, match_type, tokens, routing_reason, coords_valid, reverse_score}';

-- Helper table for alias auto-learn audit (optional, non-blocking).
CREATE TABLE IF NOT EXISTS geocoding_alias_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  organization_id UUID,
  client_id UUID,
  sender_id UUID,
  city_id UUID,
  district_id UUID,
  plugin geocoding_match_plugin,
  confidence NUMERIC(5,4),
  source TEXT,
  metadata JSONB
);

COMMENT ON TABLE geocoding_alias_audit IS 'Audit trail for auto-learned aliases promoted from provider/local scoring.';

-- RLS: least-privilege access; service + worker can write, org-scoped reads.
ALTER TABLE public.geocoding_alias_audit ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.geocoding_alias_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.geocoding_alias_audit FROM anon;
REVOKE ALL ON TABLE public.geocoding_alias_audit FROM authenticated;

GRANT ALL ON TABLE public.geocoding_alias_audit TO service_role;
GRANT SELECT, INSERT, UPDATE ON TABLE public.geocoding_alias_audit TO geocoding_worker_role;
GRANT SELECT ON TABLE public.geocoding_alias_audit TO geocoding_manual_role;
GRANT SELECT ON TABLE public.geocoding_alias_audit TO authenticated;

DROP POLICY IF EXISTS geocoding_alias_audit_service_policy ON public.geocoding_alias_audit;
CREATE POLICY geocoding_alias_audit_service_policy ON public.geocoding_alias_audit
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS geocoding_alias_audit_worker_policy ON public.geocoding_alias_audit;
CREATE POLICY geocoding_alias_audit_worker_policy ON public.geocoding_alias_audit
  FOR ALL
  TO geocoding_worker_role
  USING (
    current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
    OR organization_id = current_user_org_id()
  )
  WITH CHECK (
    current_user IN ('geocoding_worker_role', 'service_role', 'postgres', 'supabase_admin')
    OR organization_id = current_user_org_id()
  );

DROP POLICY IF EXISTS geocoding_alias_audit_org_select ON public.geocoding_alias_audit;
CREATE POLICY geocoding_alias_audit_org_select ON public.geocoding_alias_audit
  FOR SELECT
  TO authenticated
  USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS geocoding_alias_audit_manual_select ON public.geocoding_alias_audit;
CREATE POLICY geocoding_alias_audit_manual_select ON public.geocoding_alias_audit
  FOR SELECT
  TO geocoding_manual_role
  USING (organization_id = current_user_org_id());

COMMIT;
