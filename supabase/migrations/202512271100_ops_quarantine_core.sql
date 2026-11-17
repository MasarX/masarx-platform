-- Plan: PLAN-202512-ops-maintenance-universal / Step: S04
-- Migration: Ops quarantine core (SSOT)
-- Purpose:
--   - Introduce canonical ops_quarantine table for retry-exhausted/stale items.
--   - Provide a single upsert helper for consistent quarantine inserts.
-- Date: 2025-12-27

BEGIN;

CREATE TABLE IF NOT EXISTS public.ops_quarantine (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id),
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  reason TEXT,
  next_action TEXT,
  details JSONB NOT NULL DEFAULT '{}'::jsonb,
  event_count INT NOT NULL DEFAULT 1,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  resolved_by UUID REFERENCES public.users(id),
  resolution_notes TEXT,
  settings_resolution_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ops_quarantine_status_check
    CHECK (status IN ('open', 'resolved', 'dismissed', 'replayed'))
);

COMMENT ON TABLE public.ops_quarantine
  IS 'Canonical quarantine ledger for retry-exhausted or stale operations (SSOT).';
COMMENT ON COLUMN public.ops_quarantine.resource_type
  IS 'Logical resource type (outbound_call, webhook_inbox, label_job, domain_event, workflow_run, etc.).';
COMMENT ON COLUMN public.ops_quarantine.next_action
  IS 'Policy-driven next step (replay, manual_review, investigate, discard).';
COMMENT ON COLUMN public.ops_quarantine.details
  IS 'JSONB details describing failure context, attempts, and policy inputs.';

CREATE INDEX IF NOT EXISTS idx_ops_quarantine_org_status
  ON public.ops_quarantine (organization_id, status, last_seen_at DESC);
CREATE INDEX IF NOT EXISTS idx_ops_quarantine_resource
  ON public.ops_quarantine (resource_type, resource_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ops_quarantine_open_unique
  ON public.ops_quarantine (resource_type, resource_id)
  WHERE status = 'open';

ALTER TABLE public.ops_quarantine ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.ops_quarantine FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_quarantine FROM anon;
REVOKE ALL ON TABLE public.ops_quarantine FROM authenticated;

DROP POLICY IF EXISTS ops_quarantine_service_policy ON public.ops_quarantine;
CREATE POLICY ops_quarantine_service_policy
  ON public.ops_quarantine
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_ops_quarantine_set_updated_at ON public.ops_quarantine;
CREATE TRIGGER trg_ops_quarantine_set_updated_at
  BEFORE UPDATE ON public.ops_quarantine
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

CREATE OR REPLACE FUNCTION public.enqueue_ops_quarantine(
  p_organization_id UUID,
  p_resource_type TEXT,
  p_resource_id UUID,
  p_reason TEXT,
  p_next_action TEXT DEFAULT NULL,
  p_details JSONB DEFAULT '{}'::jsonb,
  p_settings_resolution_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_id UUID;
  v_details JSONB := COALESCE(p_details, '{}'::jsonb);
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_ops_quarantine requires organization_id';
  END IF;
  IF p_resource_type IS NULL OR btrim(p_resource_type) = '' THEN
    RAISE EXCEPTION 'enqueue_ops_quarantine requires resource_type';
  END IF;
  IF p_resource_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_ops_quarantine requires resource_id';
  END IF;

  INSERT INTO public.ops_quarantine (
    organization_id,
    resource_type,
    resource_id,
    status,
    reason,
    next_action,
    details,
    event_count,
    first_seen_at,
    last_seen_at,
    settings_resolution_id
  )
  VALUES (
    p_organization_id,
    p_resource_type,
    p_resource_id,
    'open',
    p_reason,
    p_next_action,
    v_details,
    1,
    now(),
    now(),
    p_settings_resolution_id
  )
  ON CONFLICT (resource_type, resource_id) WHERE status = 'open'
  DO UPDATE
    SET last_seen_at = now(),
        event_count = public.ops_quarantine.event_count + 1,
        reason = COALESCE(public.ops_quarantine.reason, EXCLUDED.reason),
        next_action = COALESCE(EXCLUDED.next_action, public.ops_quarantine.next_action),
        details = public.jsonb_deep_merge(
          COALESCE(public.ops_quarantine.details, '{}'::jsonb),
          COALESCE(EXCLUDED.details, '{}'::jsonb)
        ),
        settings_resolution_id = COALESCE(EXCLUDED.settings_resolution_id, public.ops_quarantine.settings_resolution_id)
  RETURNING id INTO v_id;

  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_ops_quarantine(UUID, TEXT, UUID, TEXT, TEXT, JSONB, UUID)
  IS 'Upsert helper for ops_quarantine (idempotent for open entries).';

COMMIT;
