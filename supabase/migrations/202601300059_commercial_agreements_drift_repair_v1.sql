-- Plan: PLAN-202602-frontend-workflow-prod-ready-finalize / Step: S04
-- Migration: Drift repair for commercial agreements tables (env.cloud)
-- Date: 2026-01-30
--
-- Problem:
--   - Downstream migrations (e.g. RBAC sensitive read gates) assume
--     public.commercial_agreements and public.commercial_agreement_terms exist.
--   - env.cloud schema drift can leave tables missing while schema_migrations
--     indicates the canonical creation migration was applied.
--
-- Approach:
--   - Idempotently (re)create canonical tables + RLS/policies/triggers/contracts.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300059_commercial_agreements_drift_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Agreement metadata (governance-only)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commercial_agreements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID REFERENCES public.clients(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.senders(id) ON DELETE CASCADE,

  agreement_code TEXT NULL,
  title TEXT NULL,
  status TEXT NOT NULL DEFAULT 'active',

  effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
  effective_until TIMESTAMPTZ NULL,
  signed_at TIMESTAMPTZ NULL,
  signed_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_agreements_scope_ck CHECK (
    (sender_id IS NOT NULL AND client_id IS NULL)
    OR (sender_id IS NULL AND client_id IS NOT NULL)
    OR (sender_id IS NULL AND client_id IS NULL)
  ),
  CONSTRAINT commercial_agreements_effective_ck CHECK (effective_until IS NULL OR effective_until > effective_from),
  CONSTRAINT commercial_agreements_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT commercial_agreements_code_ck CHECK (agreement_code IS NULL OR btrim(agreement_code) <> ''),
  CONSTRAINT commercial_agreements_title_ck CHECK (title IS NULL OR btrim(title) <> '')
);

COMMENT ON TABLE public.commercial_agreements
  IS 'Governance-only agreement registry (documents + effective dates). Operational behavior remains ladder-resolved in settings_versions.';

CREATE INDEX IF NOT EXISTS idx_commercial_agreements_org_effective
  ON public.commercial_agreements (organization_id, effective_from DESC);

CREATE INDEX IF NOT EXISTS idx_commercial_agreements_org_scope
  ON public.commercial_agreements (organization_id, client_id, sender_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_commercial_agreements_org_code
  ON public.commercial_agreements (organization_id, agreement_code)
  WHERE agreement_code IS NOT NULL AND btrim(agreement_code) <> '';

CREATE OR REPLACE FUNCTION public.commercial_agreements_enforce_org_match()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'commercial_agreements: organization_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF NEW.client_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_client_org
      FROM public.clients c
     WHERE c.id = NEW.client_id;

    IF v_client_org IS NULL THEN
      RAISE EXCEPTION 'commercial_agreements: client % not found', NEW.client_id
        USING ERRCODE = '23503';
    END IF;

    IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'commercial_agreements: organization mismatch (agreement org %, client org %)', NEW.organization_id, v_client_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_sender_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'commercial_agreements: sender % not found', NEW.sender_id
        USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'commercial_agreements: organization mismatch (agreement org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_commercial_agreements_enforce_org_match ON public.commercial_agreements;
CREATE TRIGGER trg_commercial_agreements_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.commercial_agreements
  FOR EACH ROW
  EXECUTE FUNCTION public.commercial_agreements_enforce_org_match();

-------------------------------------------------------------------------------
-- 2) Agreement term references (baseline settings_versions pointers)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.commercial_agreement_terms (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agreement_id UUID NOT NULL REFERENCES public.commercial_agreements(id) ON DELETE CASCADE,

  category TEXT NOT NULL,
  settings_version_id UUID NOT NULL,
  settings_scope_hash UUID NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000'::uuid,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT commercial_agreement_terms_category_ck CHECK (btrim(category) <> '' AND category = lower(category)),
  CONSTRAINT commercial_agreement_terms_unique UNIQUE (agreement_id, category),
  CONSTRAINT commercial_agreement_terms_settings_fk
    FOREIGN KEY (settings_version_id, settings_scope_hash)
    REFERENCES public.settings_versions (id, scope_hash)
    DEFERRABLE INITIALLY DEFERRED
);

COMMENT ON TABLE public.commercial_agreement_terms
  IS 'Agreement baseline term references: (category -> settings_versions.id). Values remain in settings_versions (SSOT).';

CREATE INDEX IF NOT EXISTS idx_commercial_agreement_terms_agreement
  ON public.commercial_agreement_terms (agreement_id, category);

CREATE OR REPLACE FUNCTION public.commercial_agreement_terms_validate_ref()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_settings_category TEXT;
  v_approved_at TIMESTAMPTZ;
BEGIN
  SELECT sv.category, sv.approved_at
    INTO v_settings_category, v_approved_at
    FROM public.settings_versions sv
   WHERE sv.id = NEW.settings_version_id
     AND sv.scope_hash = NEW.settings_scope_hash
   LIMIT 1;

  IF v_settings_category IS NULL THEN
    RAISE EXCEPTION 'commercial_agreement_terms: settings_version %/% not found', NEW.settings_version_id, NEW.settings_scope_hash
      USING ERRCODE = '23503';
  END IF;

  IF v_settings_category IS DISTINCT FROM NEW.category THEN
    RAISE EXCEPTION 'commercial_agreement_terms: category mismatch (term %, settings_versions %)', NEW.category, v_settings_category
      USING ERRCODE = '23514';
  END IF;

  IF v_approved_at IS NULL THEN
    RAISE EXCEPTION 'commercial_agreement_terms: settings_version % is not approved', NEW.settings_version_id
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_commercial_agreement_terms_validate_ref ON public.commercial_agreement_terms;
CREATE CONSTRAINT TRIGGER trg_commercial_agreement_terms_validate_ref
  AFTER INSERT OR UPDATE ON public.commercial_agreement_terms
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION public.commercial_agreement_terms_validate_ref();

-------------------------------------------------------------------------------
-- 3) RLS + least-privilege grants (tenant reads; service-only writes)
-------------------------------------------------------------------------------

ALTER TABLE public.commercial_agreements ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.commercial_agreement_terms ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.commercial_agreements FROM PUBLIC;
REVOKE ALL ON TABLE public.commercial_agreements FROM anon;
REVOKE ALL ON TABLE public.commercial_agreements FROM authenticated;

REVOKE ALL ON TABLE public.commercial_agreement_terms FROM PUBLIC;
REVOKE ALL ON TABLE public.commercial_agreement_terms FROM anon;
REVOKE ALL ON TABLE public.commercial_agreement_terms FROM authenticated;

DROP POLICY IF EXISTS commercial_agreements_select ON public.commercial_agreements;
CREATE POLICY commercial_agreements_select ON public.commercial_agreements
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS commercial_agreements_service_policy ON public.commercial_agreements;
CREATE POLICY commercial_agreements_service_policy ON public.commercial_agreements
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS commercial_agreement_terms_select ON public.commercial_agreement_terms;
CREATE POLICY commercial_agreement_terms_select ON public.commercial_agreement_terms
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.commercial_agreements a
        WHERE a.id = commercial_agreement_terms.agreement_id
          AND a.organization_id = public.current_user_org_id()
      )
    )
  );

DROP POLICY IF EXISTS commercial_agreement_terms_service_policy ON public.commercial_agreement_terms;
CREATE POLICY commercial_agreement_terms_service_policy ON public.commercial_agreement_terms
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.commercial_agreements TO authenticated;
GRANT SELECT ON public.commercial_agreement_terms TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.commercial_agreements TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.commercial_agreement_terms TO service_role;

-------------------------------------------------------------------------------
-- 4) Table contracts (SSOT): timestamps + audit (row-driven)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (
  table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes
)
VALUES
  ('public', 'commercial_agreements', TRUE, TRUE, TRUE, 'Governance-only agreements registry; audit enabled.'),
  ('public', 'commercial_agreement_terms', TRUE, TRUE, TRUE, 'Agreement baseline settings references; audit enabled.')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET created_at_required = EXCLUDED.created_at_required,
    updated_at_required = EXCLUDED.updated_at_required,
    audit_enabled = EXCLUDED.audit_enabled,
    notes = EXCLUDED.notes;

SELECT * FROM public.apply_table_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601300059_commercial_agreements_drift_repair_v1'));
COMMIT;
