-- Migration: Settings Resolution Provenance + Decision Linkage
-- Purpose: Add settings_resolution_log (HASH+RANGE) with RLS and provenance trigger to link
--          http_response_emitted decisions to resolved settings used during webhook intake.
-- Date: 2025-11-02 13:10 UTC

BEGIN;

-------------------------------------------------------------------------------
-- 1) Table: settings_resolution_log (HASH by organization_id, RANGE by resolved_at)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.settings_resolution_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES public.organizations(id),
    category TEXT NOT NULL,
    scope_path JSONB NOT NULL DEFAULT '[]'::jsonb,
    winning_scope_type TEXT NOT NULL,
    winning_scope_id UUID,
    winning_settings_id UUID,
    winning_settings_version_id UUID,
    winning_version INT,
    merge_notes JSONB,
    inputs JSONB,
    resolved_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (id, organization_id, resolved_at)
) PARTITION BY HASH (organization_id);

-- Single HASH partition for now, sub-partitioned by RANGE over time (monthly)
CREATE TABLE IF NOT EXISTS public.settings_resolution_log_p0
    PARTITION OF public.settings_resolution_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (resolved_at);

-- Create current month RANGE partition
DO $$
DECLARE
  v_from DATE := date_trunc('month', now())::date;
  v_to   DATE := (date_trunc('month', now()) + INTERVAL '1 month')::date;
  v_name TEXT := format('settings_resolution_log_%s_%s', EXTRACT(YEAR FROM v_from)::int, lpad(EXTRACT(MONTH FROM v_from)::int::text, 2, '0'));
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relname = v_name
  ) THEN
    EXECUTE format(
      'CREATE TABLE public.%I PARTITION OF public.settings_resolution_log_p0 FOR VALUES FROM (%L) TO (%L)'
      , v_name, v_from::timestamptz, v_to::timestamptz
    );
  END IF;
END $$;

-- Indexes
CREATE INDEX IF NOT EXISTS idx_settings_resolution_log_category ON public.settings_resolution_log(category);
CREATE INDEX IF NOT EXISTS idx_settings_resolution_log_winning_scope ON public.settings_resolution_log(winning_scope_type, winning_scope_id);
CREATE INDEX IF NOT EXISTS idx_settings_resolution_log_resolved_at ON public.settings_resolution_log_p0(resolved_at);

COMMENT ON TABLE public.settings_resolution_log IS 'Provenance of settings resolution (override ladder) used by decisions';
COMMENT ON COLUMN public.settings_resolution_log.scope_path IS 'Evaluated path across Global/Tenant/Client/Sender/Source';

-------------------------------------------------------------------------------
-- 2) RLS: service_role only (least-privilege)
-------------------------------------------------------------------------------

ALTER TABLE public.settings_resolution_log ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settings_resolution_log FROM PUBLIC;
REVOKE ALL ON TABLE public.settings_resolution_log FROM anon;
REVOKE ALL ON TABLE public.settings_resolution_log FROM authenticated;

DROP POLICY IF EXISTS settings_resolution_log_service_policy ON public.settings_resolution_log;
CREATE POLICY settings_resolution_log_service_policy
  ON public.settings_resolution_log
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- Note: Omit hard FK from decision_log.settings_resolution_id to settings_resolution_log.id
-- due to partitioning constraints (unique on partition key). Soft link only.

-------------------------------------------------------------------------------
-- 4) Helper to record settings provenance (optional direct use)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.log_settings_resolution(
    p_organization_id UUID,
    p_category TEXT,
    p_winning_scope_type TEXT,
    p_winning_scope_id UUID,
    p_winning_settings_id UUID,
    p_winning_settings_version_id UUID,
    p_winning_version INT,
    p_scope_path JSONB DEFAULT '[]'::jsonb,
    p_inputs JSONB DEFAULT '{}'::jsonb,
    p_merge_notes JSONB DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  INSERT INTO public.settings_resolution_log(
    id, organization_id, category, scope_path,
    winning_scope_type, winning_scope_id,
    winning_settings_id, winning_settings_version_id, winning_version,
    merge_notes, inputs, resolved_at, created_at
  ) VALUES (
    v_id, p_organization_id, p_category, COALESCE(p_scope_path, '[]'::jsonb),
    p_winning_scope_type, p_winning_scope_id,
    p_winning_settings_id, p_winning_settings_version_id, p_winning_version,
    p_merge_notes, p_inputs, now(), now()
  );
  RETURN v_id;
END;
$$;

ALTER FUNCTION public.log_settings_resolution(UUID, TEXT, TEXT, UUID, UUID, UUID, INT, JSONB, JSONB, JSONB)
  SET search_path = public, extensions, pg_temp;

COMMENT ON FUNCTION public.log_settings_resolution(UUID, TEXT, TEXT, UUID, UUID, UUID, INT, JSONB, JSONB, JSONB)
  IS 'Insert settings resolution provenance and return id.';

-------------------------------------------------------------------------------
-- 5) BEFORE INSERT trigger on decision_log to attach provenance for webhooks
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.decision_log_settings_provenance_trg()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_org UUID;
  v_cat TEXT := NEW.decision_category;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_version INT;
  v_scope_path JSONB := '[]'::jsonb;
  v_res_id UUID := NEW.resource_id;
BEGIN
  -- Only webhooks HTTP response events
  IF NEW.resource_type = 'webhook_inbox' AND NEW.decision_category = 'http_response_emitted' THEN
    SELECT organization_id, policy_scope_type, policy_scope_id, policy_settings_id, policy_version
      INTO v_org, v_scope_type, v_scope_id, v_settings_id, v_version
    FROM public.webhook_inbox
    WHERE id = v_res_id
    LIMIT 1;

    -- In some flows, the settings_version_id can be looked up via settings table
    IF v_settings_id IS NOT NULL THEN
      SELECT s.settings_version_id INTO v_settings_version_id
      FROM public.settings s
      WHERE s.id = v_settings_id
      LIMIT 1;
    END IF;

    IF v_org IS NOT NULL AND v_scope_type IS NOT NULL THEN
      v_scope_path := jsonb_build_array(v_scope_type);
      NEW.settings_resolution_id := public.log_settings_resolution(
        p_organization_id := v_org,
        p_category := 'webhook_ingest_policy',
        p_winning_scope_type := v_scope_type,
        p_winning_scope_id := v_scope_id,
        p_winning_settings_id := v_settings_id,
        p_winning_settings_version_id := v_settings_version_id,
        p_winning_version := COALESCE(v_version, 1),
        p_scope_path := v_scope_path,
        p_inputs := NULL,
        p_merge_notes := NULL
      );
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.decision_log_settings_provenance_trg()
  SET search_path = public, extensions, pg_temp;

DROP TRIGGER IF EXISTS decision_log_settings_provenance ON public.decision_log;
CREATE TRIGGER decision_log_settings_provenance
  BEFORE INSERT ON public.decision_log
  FOR EACH ROW
  EXECUTE FUNCTION public.decision_log_settings_provenance_trg();

COMMIT;
