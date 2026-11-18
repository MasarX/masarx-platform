-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-Foundation-BankRecon
-- Migration: bank_recon_matches table — explicit reconciliation membership
--   linking a bank statement finance_event row (event_type='bank_statement')
--   to a billing_invoice (or other reconcilable resource) for the FE
--   bank-reconciliation surface.
--
-- Design notes:
--   - SSOT for the bank-recon UI's "match"/"unmatch" pairing operations.
--   - Service-only writes; authenticated tenant-isolated SELECT.
--   - Append-only history is captured via decision_log + domain_events
--     emitted by the bank_recon_match_v1 / bank_recon_unmatch_v1 RPCs.
--   - bank_statement_event_id is loose-typed (UUID + occurred_at) because
--     finance_events PK is composite (id, organization_id, occurred_at).
--   - resource_type allows future extension (settlement, billing_invoice, etc.)
--     without schema changes; current FE surface focuses on billing_invoice.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281075_bank_recon_matches_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.bank_recon_matches (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  -- The bank statement finance_event being reconciled.
  bank_statement_event_id UUID NOT NULL,
  bank_statement_occurred_at TIMESTAMPTZ NOT NULL,

  -- The reconciled resource (billing_invoice for the FE bank-recon surface).
  resource_type TEXT NOT NULL,
  resource_id UUID NOT NULL,

  matched_amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,

  status TEXT NOT NULL DEFAULT 'matched',
  match_reason TEXT,
  unmatch_reason TEXT,

  matched_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  matched_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  unmatched_by UUID REFERENCES public.users(id) ON DELETE SET NULL,
  unmatched_at TIMESTAMPTZ,

  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT bank_recon_matches_status_ck CHECK (status IN ('matched', 'unmatched')),
  CONSTRAINT bank_recon_matches_resource_type_ck CHECK (btrim(resource_type) <> '' AND resource_type = lower(resource_type)),
  CONSTRAINT bank_recon_matches_currency_ck CHECK (btrim(currency) <> ''),
  CONSTRAINT bank_recon_matches_amount_ck CHECK (matched_amount > 0),
  CONSTRAINT bank_recon_matches_unmatch_consistency CHECK (
    (status = 'unmatched' AND unmatched_at IS NOT NULL)
    OR (status = 'matched' AND unmatched_at IS NULL AND unmatched_by IS NULL AND unmatch_reason IS NULL)
  )
);

COMMENT ON TABLE public.bank_recon_matches IS
  'Explicit reconciliation pairs linking bank_statement finance_event rows to billing_invoices/settlements for the FE bank-reconciliation surface. Service-only writes via bank_recon_match_v1/bank_recon_unmatch_v1 RPCs.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_bank_recon_matches_active_pair
  ON public.bank_recon_matches (organization_id, bank_statement_event_id, resource_type, resource_id)
  WHERE status = 'matched';

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_org_status
  ON public.bank_recon_matches (organization_id, status, matched_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_resource
  ON public.bank_recon_matches (resource_type, resource_id, status, matched_at DESC);

CREATE INDEX IF NOT EXISTS idx_bank_recon_matches_bank_event
  ON public.bank_recon_matches (bank_statement_event_id, status);

DROP TRIGGER IF EXISTS trg_bank_recon_matches_set_updated_at ON public.bank_recon_matches;
CREATE TRIGGER trg_bank_recon_matches_set_updated_at
  BEFORE UPDATE ON public.bank_recon_matches
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.bank_recon_matches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.bank_recon_matches FROM PUBLIC;
REVOKE ALL ON TABLE public.bank_recon_matches FROM anon;
REVOKE ALL ON TABLE public.bank_recon_matches FROM authenticated;

DROP POLICY IF EXISTS bank_recon_matches_select ON public.bank_recon_matches;
CREATE POLICY bank_recon_matches_select ON public.bank_recon_matches
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS bank_recon_matches_service_policy ON public.bank_recon_matches;
CREATE POLICY bank_recon_matches_service_policy ON public.bank_recon_matches
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON TABLE public.bank_recon_matches TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.bank_recon_matches TO service_role;

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES (
  'public', 'bank_recon_matches', TRUE, TRUE, TRUE,
  'Bank reconciliation match pairs (FE bank-recon surface). Tenant-isolated SELECT; writes via service-role RPCs only.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202604281075_bank_recon_matches_v1'));
COMMIT;
