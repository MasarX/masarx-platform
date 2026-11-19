-- pgTAP: public.v_billing_invoice_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W25 (paired projection views — FINANCE)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_billing_invoice_directory',
  'public.v_billing_invoice_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_billing_invoice_directory',
  ARRAY[
    'invoice_id', 'id', 'organization_id', 'client_id', 'sender_id',
    'invoice_number', 'status', 'status_reason',
    'currency', 'subtotal', 'tax_total', 'total',
    'amount_paid', 'amount_due',
    'period_start_at', 'period_end_at',
    'issued_at', 'due_at', 'paid_at',
    'metadata', 'created_at', 'updated_at',
    'client_label', 'client_slug', 'sender_label',
    'line_count', 'line_total_amount',
    'last_event_at', 'last_event_type',
    'sent_at', 'refunded_at', 'voided_at',
    'is_overdue', 'payment_status', 'age_days'
  ],
  'v_billing_invoice_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_billing_invoice_directory', 'SELECT'),
  'service_role has SELECT on v_billing_invoice_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_billing_invoice_directory', 'SELECT'),
  'anon has no SELECT on v_billing_invoice_directory'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_billing_invoice_directory', 'SELECT'),
  'authenticated has SELECT on v_billing_invoice_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'billing_invoices'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.billing_invoices remains a base table (SSOT preserved)'
);

-- 7) Projection: insert an invoice + lines + events, verify counters resolve.
SET LOCAL ROLE postgres;

INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-00000025f001', 'W25 Billing Org', 'w25-bi-00000000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES (
  '00000000-0000-0000-0000-00000025f002',
  '00000000-0000-0000-0000-00000025f001',
  'W25 Test Client',
  'w25-bi-cl-00000000',
  'standard',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.billing_invoices (
  id, organization_id, client_id, invoice_number, status, currency,
  subtotal, tax_total, total, amount_paid, amount_due,
  period_start_at, period_end_at, issued_at, due_at
)
VALUES (
  '00000000-0000-0000-0000-00000025f003',
  '00000000-0000-0000-0000-00000025f001',
  '00000000-0000-0000-0000-00000025f002',
  'W25-INV-001',
  'issued',
  'sar',
  100,
  15,
  115,
  0,
  115,
  '2026-04-01',
  '2026-04-30',
  now(),
  now() + interval '30 days'
)
ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      invoice_number = EXCLUDED.invoice_number,
      status = EXCLUDED.status,
      currency = EXCLUDED.currency,
      subtotal = EXCLUDED.subtotal,
      tax_total = EXCLUDED.tax_total,
      total = EXCLUDED.total,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      period_start_at = EXCLUDED.period_start_at,
      period_end_at = EXCLUDED.period_end_at,
      issued_at = EXCLUDED.issued_at,
      due_at = EXCLUDED.due_at;

INSERT INTO public.billing_invoice_lines (
  id, invoice_id, organization_id, line_type, description, quantity, unit_price, amount, currency
)
VALUES
  (
    '00000000-0000-0000-0000-00000025f004',
    '00000000-0000-0000-0000-00000025f003',
    '00000000-0000-0000-0000-00000025f001',
    'shipment_charge',
    'monthly fee',
    1,
    100,
    100,
    'sar'
  ),
  (
    '00000000-0000-0000-0000-00000025f005',
    '00000000-0000-0000-0000-00000025f003',
    '00000000-0000-0000-0000-00000025f001',
    'tax',
    'tax',
    1,
    15,
    15,
    'sar'
  )
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.billing_invoice_events (
  id, invoice_id, organization_id, event_type, invoice_version, payload
)
VALUES
  (
    '00000000-0000-0000-0000-00000025f006',
    '00000000-0000-0000-0000-00000025f003',
    '00000000-0000-0000-0000-00000025f001',
    'drafted',
    1,
    '{}'::jsonb
  ),
  (
    '00000000-0000-0000-0000-00000025f007',
    '00000000-0000-0000-0000-00000025f003',
    '00000000-0000-0000-0000-00000025f001',
    'billing_invoice.issued',
    2,
    '{}'::jsonb
  )
ON CONFLICT (id) DO NOTHING;

SELECT ok(
  line_count = 2
    AND line_total_amount = 115
    AND payment_status = 'issued'
    AND client_label = 'W25 Test Client',
  'v_billing_invoice_directory derives line_count + line_total_amount + payment_status + client_label'
)
FROM public.v_billing_invoice_directory
WHERE invoice_id = '00000000-0000-0000-0000-00000025f003';

-- 8) Overdue derivation: invoice past due_at + status='issued' resolves to 'overdue'.
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-00000025f011', 'W25 Overdue Org', 'w25-bi-od-00000000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES (
  '00000000-0000-0000-0000-00000025f012',
  '00000000-0000-0000-0000-00000025f011',
  'W25 Overdue Client',
  'w25-bi-od-cl-00000000',
  'standard',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.billing_invoices (
  id, organization_id, client_id, invoice_number, status, currency,
  subtotal, tax_total, total, amount_paid, amount_due,
  issued_at, due_at
)
VALUES (
  '00000000-0000-0000-0000-00000025f013',
  '00000000-0000-0000-0000-00000025f011',
  '00000000-0000-0000-0000-00000025f012',
  'W25-INV-OVERDUE',
  'issued',
  'sar',
  50,
  0,
  50,
  0,
  50,
  '2025-01-01T00:00:00Z',
  '2025-01-15T00:00:00Z'
)
ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      invoice_number = EXCLUDED.invoice_number,
      status = EXCLUDED.status,
      currency = EXCLUDED.currency,
      subtotal = EXCLUDED.subtotal,
      tax_total = EXCLUDED.tax_total,
      total = EXCLUDED.total,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      issued_at = EXCLUDED.issued_at,
      due_at = EXCLUDED.due_at;

SELECT ok(
  is_overdue = TRUE AND payment_status = 'overdue',
  'v_billing_invoice_directory.is_overdue/payment_status flag past-due issued invoice as overdue'
)
FROM public.v_billing_invoice_directory
WHERE invoice_id = '00000000-0000-0000-0000-00000025f013';

-- 9) Zero-due issued invoices are not actionable overdue receivables.
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-00000025f021', 'W25 Zero Due Org', 'w25-bi-zd-00000000')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug, sla_tier, status)
VALUES (
  '00000000-0000-0000-0000-00000025f022',
  '00000000-0000-0000-0000-00000025f021',
  'W25 Zero Due Client',
  'w25-bi-zd-cl-00000000',
  'standard',
  'active'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.billing_invoices (
  id, organization_id, client_id, invoice_number, status, currency,
  subtotal, tax_total, total, amount_paid, amount_due,
  issued_at, due_at
)
VALUES (
  '00000000-0000-0000-0000-00000025f023',
  '00000000-0000-0000-0000-00000025f021',
  '00000000-0000-0000-0000-00000025f022',
  'W25-INV-ZERO-DUE',
  'issued',
  'sar',
  0,
  0,
  0,
  0,
  0,
  '2025-01-01T00:00:00Z',
  '2025-01-15T00:00:00Z'
)
ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      client_id = EXCLUDED.client_id,
      invoice_number = EXCLUDED.invoice_number,
      status = EXCLUDED.status,
      currency = EXCLUDED.currency,
      subtotal = EXCLUDED.subtotal,
      tax_total = EXCLUDED.tax_total,
      total = EXCLUDED.total,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      issued_at = EXCLUDED.issued_at,
      due_at = EXCLUDED.due_at;

SELECT ok(
  is_overdue = FALSE AND payment_status = 'issued',
  'v_billing_invoice_directory keeps zero-due issued invoices out of overdue queues'
)
FROM public.v_billing_invoice_directory
WHERE invoice_id = '00000000-0000-0000-0000-00000025f023';

SELECT * FROM finish();
ROLLBACK;
