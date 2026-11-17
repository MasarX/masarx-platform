-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Feedback events v1 (post-delivery CX ledger)
-- Date: 2026-01-31
--
-- Goals:
--   - Add a minimal, audit-grade feedback ledger for ratings/NPS/comments tied to shipments/recipients.
--   - Keep behavior row-driven (channel + capture window policy later); schema-only here.
--   - Enforce strict RLS and lookup contracts (no literal enum lists).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311730_feedback_events_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('feedback_channel', 'Feedback submission channel (in-app/web/sms/etc.)', 'operations', 'tier_1', TRUE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  v.metadata::jsonb
FROM public.lookup_definitions ld
CROSS JOIN (VALUES
  ('in_app',   'In-App',   'In-app prompt', 10, TRUE,  '{}' ),
  ('web',      'Web',      'Web form', 20, FALSE, '{}' ),
  ('whatsapp', 'WhatsApp', 'WhatsApp link', 30, FALSE, '{}' ),
  ('sms',      'SMS',      'SMS link', 40, FALSE, '{}' ),
  ('email',    'Email',    'Email link', 50, FALSE, '{}' ),
  ('phone',    'Phone',    'Phone call survey', 60, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'feedback_channel'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) feedback_events ledger (SSOT)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feedback_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  client_id UUID REFERENCES public.clients(id) ON DELETE SET NULL,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,
  recipient_id UUID REFERENCES public.recipients(id) ON DELETE SET NULL,

  -- Optional: tie to a shipment for analytics and dispute correlation.
  shipment_id UUID NULL,

  channel TEXT NOT NULL DEFAULT 'in_app', -- lookup feedback_channel
  rating INT NULL, -- 1..5 (optional)
  nps_score INT NULL, -- 0..10 (optional)
  comment TEXT NULL,

  submitted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT feedback_events_channel_ck CHECK (btrim(channel) <> '' AND channel = lower(channel)),
  CONSTRAINT feedback_events_rating_ck CHECK (rating IS NULL OR (rating >= 1 AND rating <= 5)),
  CONSTRAINT feedback_events_nps_ck CHECK (nps_score IS NULL OR (nps_score >= 0 AND nps_score <= 10))
);

COMMENT ON TABLE public.feedback_events
  IS 'Immutable feedback ledger (SSOT) for post-delivery ratings/NPS/comments. Projections and KPIs derive from this table.';

CREATE INDEX IF NOT EXISTS idx_feedback_events_org_created
  ON public.feedback_events (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_events_client_created
  ON public.feedback_events (client_id, created_at DESC)
  WHERE client_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_events__client_id__fk
  ON public.feedback_events (client_id);

CREATE INDEX IF NOT EXISTS idx_feedback_events_sender_created
  ON public.feedback_events (sender_id, created_at DESC)
  WHERE sender_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_events_recipient_created
  ON public.feedback_events (recipient_id, created_at DESC)
  WHERE recipient_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feedback_events_shipment
  ON public.feedback_events (shipment_id)
  WHERE shipment_id IS NOT NULL;

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_feedback_events__sender_id__fk
  ON public.feedback_events (sender_id);

CREATE INDEX IF NOT EXISTS idx_feedback_events__recipient_id__fk
  ON public.feedback_events (recipient_id);

-------------------------------------------------------------------------------
-- 3) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.feedback_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.feedback_events FROM PUBLIC;
REVOKE ALL ON TABLE public.feedback_events FROM anon;
REVOKE ALL ON TABLE public.feedback_events FROM authenticated;

DROP POLICY IF EXISTS feedback_events_select ON public.feedback_events;
CREATE POLICY feedback_events_select ON public.feedback_events
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
    OR (
      public.current_user_scope_type() = 'client'
      AND client_id IS NOT NULL
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id IS NOT NULL
      AND sender_id = public.current_user_sender_id()
    )
  );

DROP POLICY IF EXISTS feedback_events_service_policy ON public.feedback_events;
CREATE POLICY feedback_events_service_policy ON public.feedback_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.feedback_events TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.feedback_events TO service_role;

-------------------------------------------------------------------------------
-- 4) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'feedback_events', TRUE, FALSE, FALSE, 'Feedback ledger (SSOT) for CX analytics.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'feedback_events', 'channel', 'feedback_channel')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311730_feedback_events_v1'));
COMMIT;
