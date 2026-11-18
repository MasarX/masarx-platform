-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: Support cases schema extension v1
-- Date: 2026-04-27
--
-- Purpose:
--   Extend public.support_cases with FE-driven canonical fields the audit identified
--   (subject, channel, tags). Introduce support_case_tags ledger table for tag history
--   and align lookup_values with the canonical statuses already shipped.
--
-- Decisions (per Phase B3 plan):
--   - subject  : add as TEXT column (nullable; case lifecycle drives fill)
--   - channel  : add as TEXT column (lookup-validated via support_message_channel)
--   - tags     : add as TEXT[] column (denormalized projection); ledger lives in support_case_tags
--   - last_message_at / message_count / sla_breached are COMPUTED in v_support_case_summary
--     (separate migration) — never duplicated to base table.
--   - FE 'pending' status is NOT in canonical lookup. We keep FE aligned to canonical
--     ('open','in_progress','resolved','closed','canceled'); FE must drop 'pending'.
--
-- Notes:
--   - Append-only; uses additive ADD COLUMN guards and idempotent table creation.
--   - support_case_tags is RLS-enforced; mirrors support_messages pattern.
--   - No business behavior is hardcoded in this migration; this is purely structural.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271200_support_cases_schema_extension_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Add canonical FE-driven columns to public.support_cases
-------------------------------------------------------------------------------

ALTER TABLE public.support_cases
  ADD COLUMN IF NOT EXISTS subject TEXT,
  ADD COLUMN IF NOT EXISTS channel TEXT,
  ADD COLUMN IF NOT EXISTS tags    TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Light hygiene constraints; lookup contract is enforced via lookup_column_contracts.
ALTER TABLE public.support_cases
  DROP CONSTRAINT IF EXISTS support_cases_channel_ck;
ALTER TABLE public.support_cases
  ADD CONSTRAINT support_cases_channel_ck
    CHECK (channel IS NULL OR (btrim(channel) <> '' AND channel = lower(channel)));

ALTER TABLE public.support_cases
  DROP CONSTRAINT IF EXISTS support_cases_subject_ck;
ALTER TABLE public.support_cases
  ADD CONSTRAINT support_cases_subject_ck
    CHECK (subject IS NULL OR btrim(subject) <> '');

-- Helpful index for filtering recent cases by channel.
CREATE INDEX IF NOT EXISTS idx_support_cases_org_channel
  ON public.support_cases (organization_id, channel, created_at DESC)
  WHERE channel IS NOT NULL;

-- GIN index on tags so FE filter "tag IN (...)" stays sub-linear.
CREATE INDEX IF NOT EXISTS idx_support_cases_tags_gin
  ON public.support_cases USING GIN (tags);

COMMENT ON COLUMN public.support_cases.subject IS 'Short human-readable subject line for the case (FE drives fill; nullable for legacy rows).';
COMMENT ON COLUMN public.support_cases.channel IS 'Originating channel (lookup support_message_channel). Persisted for filter/UX.';
COMMENT ON COLUMN public.support_cases.tags    IS 'Denormalized current tag projection (SSOT history is support_case_tags). Lookup-free; controlled by add_support_tag_v1.';

-------------------------------------------------------------------------------
-- 2) Register lookup column contract for the new channel column
-------------------------------------------------------------------------------

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES ('public', 'support_cases', 'channel', 'support_message_channel')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
  SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

-------------------------------------------------------------------------------
-- 3) support_case_tags ledger (history of tag attach/detach)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.support_case_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  support_case_id UUID NOT NULL REFERENCES public.support_cases(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  tag TEXT NOT NULL,
  action TEXT NOT NULL DEFAULT 'add', -- 'add' | 'remove'

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT support_case_tags_tag_ck CHECK (btrim(tag) <> '' AND tag = lower(tag)),
  CONSTRAINT support_case_tags_action_ck CHECK (action IN ('add', 'remove'))
);

COMMENT ON TABLE public.support_case_tags
  IS 'Immutable history of support case tag attach/detach. SSOT for tag audit trail.';

CREATE INDEX IF NOT EXISTS idx_support_case_tags_case_created
  ON public.support_case_tags (support_case_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_case_tags_org_created
  ON public.support_case_tags (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_support_case_tags_tag
  ON public.support_case_tags (organization_id, tag);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_support_case_tags__actor_user_id__fk
  ON public.support_case_tags (actor_user_id);

-------------------------------------------------------------------------------
-- 4) RLS + grants for support_case_tags
-------------------------------------------------------------------------------

ALTER TABLE public.support_case_tags ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.support_case_tags FROM PUBLIC;
REVOKE ALL ON TABLE public.support_case_tags FROM anon;
REVOKE ALL ON TABLE public.support_case_tags FROM authenticated;

DROP POLICY IF EXISTS support_case_tags_select ON public.support_case_tags;
CREATE POLICY support_case_tags_select ON public.support_case_tags
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
      AND EXISTS (
        SELECT 1
        FROM public.support_cases sc
        WHERE sc.id = support_case_tags.support_case_id
          AND sc.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.support_cases sc
        WHERE sc.id = support_case_tags.support_case_id
          AND sc.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS support_case_tags_service_policy ON public.support_case_tags;
CREATE POLICY support_case_tags_service_policy ON public.support_case_tags
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.support_case_tags TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.support_case_tags TO service_role;

-------------------------------------------------------------------------------
-- 5) Contracts: register support_case_tags
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'support_case_tags', TRUE, FALSE, FALSE, 'Support case tag attach/detach ledger (SSOT for tag history).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202604271200_support_cases_schema_extension_v1'));
COMMIT;
