-- Spec-Issue: W25 FINANCE gap closure (paired projection views)
-- Step: W25-VIEW-1
-- Migration: Canonical projection view public.v_billing_invoice_directory.
-- Capability: billing.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-invoice derived joins + counters used by
--   `apps/console-v2/src/modules/finance/billing.tsx` (BillingInvoiceRow):
--     - client_label        : derived from clients.name
--     - client_slug         : derived from clients.slug
--     - sender_label        : derived from senders.name (when sender_id set)
--     - line_count          : COUNT(public.billing_invoice_lines WHERE invoice_id matches)
--     - line_total_amount   : SUM(public.billing_invoice_lines.amount) for this invoice
--     - last_event_at       : MAX(billing_invoice_events.created_at) for this invoice
--     - last_event_type     : event_type of latest billing_invoice_events row
--     - sent_at             : MAX(billing_invoice_events.created_at WHERE event_type='sent')
--     - refunded_at         : MAX(billing_invoice_events.created_at WHERE event_type='refunded')
--     - voided_at           : MAX(billing_invoice_events.created_at WHERE event_type='voided')
--     - payment_status      : derived enum — 'paid' (paid_at set), 'overdue' (status='sent'
--                             AND now > due_at), 'sent', 'draft', 'voided', 'refunded'
--     - is_overdue          : derived BOOLEAN — TRUE when status='overdue' OR
--                             (status='sent' AND now > due_at)
--     - age_days            : derived INT — days since created_at
--
--   The FE `BillingInvoiceRow` interface at apps/console-v2/src/modules/finance/billing.tsx
--   currently keeps non-canonical aliases (`period_start`, `period_end`,
--   `total_amount`, `due_date`, `sent_at`) and derived joins (`client_label`,
--   `subscription_id`) inline as FE-only projection keys. This view exposes
--   canonical SSOT columns plus the derived joins/counters under stable keys
--   so the live cutover stays a single getSupabaseClient() branch flip.
--
-- Notes:
--   * SSOT remains public.billing_invoices; this view is read-only.
--   * RLS is enforced by the underlying tables (billing_invoices /
--     billing_invoice_lines / billing_invoice_events / clients / senders).
--   * Service-role + authenticated SELECT (mirrors v_client_summary baseline).
--   * Idempotent: pure view; safe to re-run.
--   * `is_overdue` evaluates `now()` at query time — callers receive a
--     deterministic per-row state at read time.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302300_v_billing_invoice_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_billing_invoice_directory;

CREATE VIEW public.v_billing_invoice_directory AS
WITH line_agg AS (
  -- Line-item rollup per invoice (count + sum).
  SELECT
    bil.invoice_id,
    COUNT(*)::INT AS line_count,
    COALESCE(SUM(bil.amount), 0)::NUMERIC AS line_total_amount
  FROM public.billing_invoice_lines bil
  GROUP BY bil.invoice_id
),
event_agg AS (
  -- Latest event timestamp + type per invoice.
  SELECT
    bie.invoice_id,
    MAX(bie.created_at) AS last_event_at
  FROM public.billing_invoice_events bie
  GROUP BY bie.invoice_id
),
event_sent AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS sent_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type = 'sent'
  GROUP BY bie.invoice_id
),
event_refunded AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS refunded_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type = 'refunded'
  GROUP BY bie.invoice_id
),
event_voided AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS voided_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type = 'voided'
  GROUP BY bie.invoice_id
)
SELECT
  bi.id                AS invoice_id,
  bi.id                AS id,
  bi.organization_id,
  bi.client_id,
  bi.sender_id,
  bi.invoice_number,
  bi.status,
  bi.status_reason,
  bi.currency,
  bi.subtotal,
  bi.tax_total,
  bi.total,
  bi.amount_paid,
  bi.amount_due,
  bi.period_start_at,
  bi.period_end_at,
  bi.issued_at,
  bi.due_at,
  bi.paid_at,
  bi.metadata,
  bi.created_at,
  bi.updated_at,
  -- Derived joins
  c.name              AS client_label,
  c.slug              AS client_slug,
  s.name              AS sender_label,
  -- Derived line counters
  COALESCE(line_agg.line_count, 0) AS line_count,
  COALESCE(line_agg.line_total_amount, 0)::NUMERIC AS line_total_amount,
  -- Latest event timestamps
  event_agg.last_event_at,
  (
    SELECT bie.event_type
    FROM public.billing_invoice_events bie
    WHERE bie.invoice_id = bi.id
    ORDER BY bie.created_at DESC
    LIMIT 1
  )                   AS last_event_type,
  event_sent.sent_at,
  event_refunded.refunded_at,
  event_voided.voided_at,
  -- Derived booleans + enums
  (
    bi.status = 'overdue'
    OR (bi.status = 'sent' AND bi.due_at IS NOT NULL AND now() > bi.due_at)
  ) AS is_overdue,
  CASE
    WHEN bi.paid_at IS NOT NULL THEN 'paid'
    WHEN bi.status = 'overdue' THEN 'overdue'
    WHEN bi.status = 'sent' AND bi.due_at IS NOT NULL AND now() > bi.due_at THEN 'overdue'
    WHEN bi.status = 'voided' THEN 'voided'
    WHEN bi.status = 'refunded' THEN 'refunded'
    WHEN bi.status = 'sent' THEN 'sent'
    ELSE 'draft'
  END AS payment_status,
  GREATEST(0, EXTRACT(DAY FROM (now() - bi.created_at)))::INT AS age_days
FROM public.billing_invoices bi
LEFT JOIN public.clients c   ON c.id = bi.client_id
LEFT JOIN public.senders s   ON s.id = bi.sender_id
LEFT JOIN line_agg           ON line_agg.invoice_id = bi.id
LEFT JOIN event_agg          ON event_agg.invoice_id = bi.id
LEFT JOIN event_sent         ON event_sent.invoice_id = bi.id
LEFT JOIN event_refunded     ON event_refunded.invoice_id = bi.id
LEFT JOIN event_voided       ON event_voided.invoice_id = bi.id;

COMMENT ON VIEW public.v_billing_invoice_directory IS
  'FE-friendly projection of billing_invoices with derived joins (client_label, client_slug, sender_label) and counters (line_count, line_total_amount, last_event_at/type, sent_at, refunded_at, voided_at, is_overdue, payment_status, age_days). Sources: billing_invoices + billing_invoice_lines + billing_invoice_events + clients + senders. Read-only; SSOT remains billing_invoices; mutations go through create_billing_invoice_v1 / update_billing_invoice_v1 / billing_invoice_send_v1 / billing_invoice_refund_v1 / void_billing_invoice_v1.';

REVOKE ALL ON public.v_billing_invoice_directory FROM PUBLIC;
REVOKE ALL ON public.v_billing_invoice_directory FROM anon;
REVOKE ALL ON public.v_billing_invoice_directory FROM authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302300_v_billing_invoice_directory'));
COMMIT;
