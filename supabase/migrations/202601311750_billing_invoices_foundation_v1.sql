-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Billing invoices foundation v1 (client AR projections + invoice events)
-- Date: 2026-01-31
--
-- Goals:
--   - Add minimal invoice structures for enterprise client billing:
--     - billing_invoices (projection)
--     - billing_invoice_lines (projection)
--     - billing_invoice_events (immutable ledger)
--   - Keep billing logic row-driven (pricing_policy + finance_events drive line generation later).
--   - Enforce strict RLS and lookup contracts (no literal enum lists).
BEGIN;
SELECT pg_advisory_lock(hashtext('202601311750_billing_invoices_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Lookups (row-driven enums; SSOT)
-------------------------------------------------------------------------------

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('billing_invoice_status', 'Billing invoice status (projection)', 'finance', 'tier_1', TRUE)
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
  ('draft',   'Draft',   'Draft invoice (not issued)', 10, TRUE,  '{}' ),
  ('issued',  'Issued',  'Issued to client', 20, FALSE, '{}' ),
  ('overdue', 'Overdue', 'Past due date', 30, FALSE, '{}' ),
  ('paid',    'Paid',    'Paid in full', 40, FALSE, '{"is_final": true}' ),
  ('void',    'Void',    'Voided/invalidated', 90, FALSE, '{"is_final": true}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'billing_invoice_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES ('billing_invoice_line_type', 'Billing invoice line types (shipment charge, cod fee, adjustment)', 'finance', 'tier_1', TRUE)
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
  ('shipment_charge', 'Shipment Charge', 'Shipment delivery/pickup charge', 10, TRUE,  '{}' ),
  ('cod_fee',         'COD Fee',         'Cash-on-delivery fee', 20, FALSE, '{}' ),
  ('adjustment',      'Adjustment',      'Manual adjustment/credit/debit', 30, FALSE, '{}' ),
  ('tax',             'Tax',             'Tax line', 40, FALSE, '{}' )
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'billing_invoice_line_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) billing_invoices projection
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_invoices (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  sender_id UUID REFERENCES public.senders(id) ON DELETE SET NULL,

  invoice_number TEXT NULL,
  status TEXT NOT NULL DEFAULT 'draft', -- lookup billing_invoice_status
  status_reason TEXT,

  currency TEXT NOT NULL,
  subtotal NUMERIC NOT NULL DEFAULT 0,
  tax_total NUMERIC NOT NULL DEFAULT 0,
  total NUMERIC NOT NULL DEFAULT 0,
  amount_paid NUMERIC NOT NULL DEFAULT 0,
  amount_due NUMERIC NOT NULL DEFAULT 0,

  period_start_at TIMESTAMPTZ NULL,
  period_end_at TIMESTAMPTZ NULL,
  issued_at TIMESTAMPTZ NULL,
  due_at TIMESTAMPTZ NULL,
  paid_at TIMESTAMPTZ NULL,

  created_by_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,

  idempotency_key TEXT,
  version INT NOT NULL DEFAULT 1,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_invoices_status_ck CHECK (btrim(status) <> '' AND status = lower(status)),
  CONSTRAINT billing_invoices_currency_ck CHECK (btrim(currency) <> ''),
  CONSTRAINT billing_invoices_totals_ck CHECK (
    subtotal >= 0 AND tax_total >= 0 AND total >= 0 AND amount_paid >= 0 AND amount_due >= 0
  ),
  CONSTRAINT billing_invoices_period_ck CHECK (
    period_start_at IS NULL OR period_end_at IS NULL OR period_end_at >= period_start_at
  ),
  CONSTRAINT billing_invoices_version_ck CHECK (version > 0)
);

COMMENT ON TABLE public.billing_invoices
  IS 'Client billing invoice projection (query-optimized). Immutable audit trail is billing_invoice_events; line items in billing_invoice_lines.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_org_invoice_number
  ON public.billing_invoices (organization_id, invoice_number)
  WHERE invoice_number IS NOT NULL AND btrim(invoice_number) <> '';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_org_idempotency
  ON public.billing_invoices (organization_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> '';

CREATE INDEX IF NOT EXISTS idx_billing_invoices_org_status
  ON public.billing_invoices (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_client_status
  ON public.billing_invoices (client_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_sender_status
  ON public.billing_invoices (sender_id, status, created_at DESC)
  WHERE sender_id IS NOT NULL;

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_billing_invoices__sender_id__fk
  ON public.billing_invoices (sender_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoices__created_by_user_id__fk
  ON public.billing_invoices (created_by_user_id);

CREATE OR REPLACE FUNCTION public.billing_invoices_enforce_org_match_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_client_org UUID;
  v_sender_org UUID;
  v_user_org UUID;
BEGIN
  IF NEW.organization_id IS NULL THEN
    RAISE EXCEPTION 'billing_invoices: organization_id is required' USING ERRCODE = '23502';
  END IF;

  SELECT c.organization_id INTO v_client_org
  FROM public.clients c
  WHERE c.id = NEW.client_id;

  IF v_client_org IS NULL THEN
    RAISE EXCEPTION 'billing_invoices: client % not found', NEW.client_id USING ERRCODE = '23503';
  END IF;

  IF v_client_org IS DISTINCT FROM NEW.organization_id THEN
    RAISE EXCEPTION 'billing_invoices: organization mismatch (invoice org %, client org %)', NEW.organization_id, v_client_org
      USING ERRCODE = '23514';
  END IF;

  IF NEW.sender_id IS NOT NULL THEN
    SELECT c.organization_id
      INTO v_sender_org
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = NEW.sender_id;

    IF v_sender_org IS NULL THEN
      RAISE EXCEPTION 'billing_invoices: sender % not found', NEW.sender_id USING ERRCODE = '23503';
    END IF;

    IF v_sender_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'billing_invoices: organization mismatch (invoice org %, sender org %)', NEW.organization_id, v_sender_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.created_by_user_id IS NOT NULL THEN
    SELECT u.organization_id INTO v_user_org
    FROM public.users u
    WHERE u.id = NEW.created_by_user_id;

    IF v_user_org IS NULL THEN
      RAISE EXCEPTION 'billing_invoices: user % not found', NEW.created_by_user_id USING ERRCODE = '23503';
    END IF;

    IF v_user_org IS DISTINCT FROM NEW.organization_id THEN
      RAISE EXCEPTION 'billing_invoices: organization mismatch (invoice org %, user org %)', NEW.organization_id, v_user_org
        USING ERRCODE = '23514';
    END IF;
  END IF;

  RETURN NEW;
END;
$function$;

DROP TRIGGER IF EXISTS trg_billing_invoices_enforce_org_match ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoices_enforce_org_match
  BEFORE INSERT OR UPDATE ON public.billing_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.billing_invoices_enforce_org_match_v1();

DROP TRIGGER IF EXISTS trg_billing_invoices_set_updated_at ON public.billing_invoices;
CREATE TRIGGER trg_billing_invoices_set_updated_at
  BEFORE UPDATE ON public.billing_invoices
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

-------------------------------------------------------------------------------
-- 3) billing_invoice_lines projection
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_invoice_lines (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  line_type TEXT NOT NULL, -- lookup billing_invoice_line_type
  description TEXT,

  quantity NUMERIC NOT NULL DEFAULT 1,
  unit_price NUMERIC,
  amount NUMERIC NOT NULL,
  currency TEXT NOT NULL,

  resource_type TEXT,
  resource_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_invoice_lines_line_type_ck CHECK (btrim(line_type) <> '' AND line_type = lower(line_type)),
  CONSTRAINT billing_invoice_lines_currency_ck CHECK (btrim(currency) <> ''),
  CONSTRAINT billing_invoice_lines_qty_ck CHECK (quantity >= 0),
  CONSTRAINT billing_invoice_lines_amount_ck CHECK (amount >= 0)
);

COMMENT ON TABLE public.billing_invoice_lines
  IS 'Invoice line items projection. Typically generated from finance_events + pricing policy; manual adjustments are allowed via service_role.';

CREATE INDEX IF NOT EXISTS idx_billing_invoice_lines_invoice
  ON public.billing_invoice_lines (invoice_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_lines_org_created
  ON public.billing_invoice_lines (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_billing_invoice_lines__invoice_id__fk
  ON public.billing_invoice_lines (invoice_id);

-------------------------------------------------------------------------------
-- 4) billing_invoice_events ledger
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.billing_invoice_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id UUID NOT NULL REFERENCES public.billing_invoices(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,

  event_type TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT,

  actor_user_id UUID REFERENCES public.users(id) ON DELETE SET NULL,
  actor_system TEXT,

  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  idempotency_key TEXT,
  invoice_version INT NOT NULL,

  decision_log_id UUID,
  settings_resolution_id UUID,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT billing_invoice_events_event_type_ck CHECK (btrim(event_type) <> '' AND event_type = lower(event_type)),
  CONSTRAINT billing_invoice_events_invoice_version_ck CHECK (invoice_version > 0)
);

COMMENT ON TABLE public.billing_invoice_events
  IS 'Immutable billing invoice event ledger (SSOT). billing_invoices is the projection.';

CREATE INDEX IF NOT EXISTS idx_billing_invoice_events_invoice_created
  ON public.billing_invoice_events (invoice_id, created_at DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoice_events_invoice_version
  ON public.billing_invoice_events (invoice_id, invoice_version);

CREATE INDEX IF NOT EXISTS idx_billing_invoice_events_org_created
  ON public.billing_invoice_events (organization_id, created_at DESC);

-- FK supporting indexes (enterprise hygiene; non-partial).
CREATE INDEX IF NOT EXISTS idx_billing_invoice_events__actor_user_id__fk
  ON public.billing_invoice_events (actor_user_id);

-------------------------------------------------------------------------------
-- 5) RLS + grants
-------------------------------------------------------------------------------

ALTER TABLE public.billing_invoices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_lines ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.billing_invoice_events ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.billing_invoices FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_invoices FROM anon;
REVOKE ALL ON TABLE public.billing_invoices FROM authenticated;

REVOKE ALL ON TABLE public.billing_invoice_lines FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_invoice_lines FROM anon;
REVOKE ALL ON TABLE public.billing_invoice_lines FROM authenticated;

REVOKE ALL ON TABLE public.billing_invoice_events FROM PUBLIC;
REVOKE ALL ON TABLE public.billing_invoice_events FROM anon;
REVOKE ALL ON TABLE public.billing_invoice_events FROM authenticated;

DROP POLICY IF EXISTS billing_invoices_select ON public.billing_invoices;
CREATE POLICY billing_invoices_select ON public.billing_invoices
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
      AND client_id = public.current_user_client_id()
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND sender_id IS NOT NULL
      AND sender_id = public.current_user_sender_id()
    )
  );

DROP POLICY IF EXISTS billing_invoices_service_policy ON public.billing_invoices;
CREATE POLICY billing_invoices_service_policy ON public.billing_invoices
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS billing_invoice_lines_select ON public.billing_invoice_lines;
CREATE POLICY billing_invoice_lines_select ON public.billing_invoice_lines
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
        FROM public.billing_invoices i
        WHERE i.id = billing_invoice_lines.invoice_id
          AND i.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.billing_invoices i
        WHERE i.id = billing_invoice_lines.invoice_id
          AND i.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS billing_invoice_lines_service_policy ON public.billing_invoice_lines;
CREATE POLICY billing_invoice_lines_service_policy ON public.billing_invoice_lines
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS billing_invoice_events_select ON public.billing_invoice_events;
CREATE POLICY billing_invoice_events_select ON public.billing_invoice_events
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
        FROM public.billing_invoices i
        WHERE i.id = billing_invoice_events.invoice_id
          AND i.client_id = public.current_user_client_id()
      )
    )
    OR (
      public.current_user_scope_type() = 'sender'
      AND EXISTS (
        SELECT 1
        FROM public.billing_invoices i
        WHERE i.id = billing_invoice_events.invoice_id
          AND i.sender_id = public.current_user_sender_id()
      )
    )
  );

DROP POLICY IF EXISTS billing_invoice_events_service_policy ON public.billing_invoice_events;
CREATE POLICY billing_invoice_events_service_policy ON public.billing_invoice_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

GRANT SELECT ON public.billing_invoices TO authenticated;
GRANT SELECT ON public.billing_invoice_lines TO authenticated;
GRANT SELECT ON public.billing_invoice_events TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_invoices TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_invoice_lines TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.billing_invoice_events TO service_role;

-------------------------------------------------------------------------------
-- 6) Contracts: table_contracts + lookup_column_contracts
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (table_schema, table_name, created_at_required, updated_at_required, audit_enabled, notes)
VALUES
  ('public', 'billing_invoices', TRUE, TRUE, TRUE, 'Client billing invoices projection (AR).'),
  ('public', 'billing_invoice_lines', TRUE, FALSE, FALSE, 'Invoice line items projection (deterministic from finance events).'),
  ('public', 'billing_invoice_events', TRUE, FALSE, FALSE, 'Invoice event ledger (SSOT).')
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

INSERT INTO public.lookup_column_contracts (table_schema, table_name, column_name, lookup_category)
VALUES
  ('public', 'billing_invoices', 'status', 'billing_invoice_status'),
  ('public', 'billing_invoice_lines', 'line_type', 'billing_invoice_line_type')
ON CONFLICT (table_schema, table_name, column_name) DO UPDATE
SET lookup_category = EXCLUDED.lookup_category;

SELECT public.apply_lookup_column_contracts('public');

SELECT pg_advisory_unlock(hashtext('202601311750_billing_invoices_foundation_v1'));
COMMIT;

