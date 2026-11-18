-- Spec-Issue: W25 FINANCE projection repair
-- Step: W25-BILLING-STATUS-REPAIR-1
-- Migration: Align v_billing_invoice_directory with canonical billing_invoice_status.
--
-- Canonical invoice states are row-driven by billing_invoice_status:
-- draft, issued, overdue, paid, void. The original W25 directory view still
-- derived payment state from legacy sent/voided/refunded literals, while the
-- write RPCs now emit issued/void states and billing_invoice.* event names.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031680_billing_invoice_directory_status_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_billing_invoice_directory;

CREATE VIEW public.v_billing_invoice_directory
WITH (security_invoker = true)
AS
WITH line_agg AS (
  SELECT
    bil.invoice_id,
    COUNT(*)::INT AS line_count,
    COALESCE(SUM(bil.amount), 0)::NUMERIC AS line_total_amount
  FROM public.billing_invoice_lines bil
  GROUP BY bil.invoice_id
),
event_agg AS (
  SELECT
    bie.invoice_id,
    MAX(bie.created_at) AS last_event_at
  FROM public.billing_invoice_events bie
  GROUP BY bie.invoice_id
),
event_sent AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS sent_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.issued', 'sent')
  GROUP BY bie.invoice_id
),
event_refunded AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS refunded_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.refunded', 'refunded')
  GROUP BY bie.invoice_id
),
event_voided AS (
  SELECT bie.invoice_id, MAX(bie.created_at) AS voided_at
  FROM public.billing_invoice_events bie
  WHERE bie.event_type IN ('billing_invoice.voided', 'voided')
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
  c.name              AS client_label,
  c.slug              AS client_slug,
  s.name              AS sender_label,
  COALESCE(line_agg.line_count, 0) AS line_count,
  COALESCE(line_agg.line_total_amount, 0)::NUMERIC AS line_total_amount,
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
  (
    bi.status = 'overdue'
    OR (bi.status = 'issued' AND bi.due_at IS NOT NULL AND now() > bi.due_at)
  ) AS is_overdue,
  CASE
    WHEN bi.paid_at IS NOT NULL THEN 'paid'
    WHEN bi.status = 'overdue' THEN 'overdue'
    WHEN bi.status = 'issued' AND bi.due_at IS NOT NULL AND now() > bi.due_at THEN 'overdue'
    WHEN bi.status = 'void' THEN 'void'
    WHEN bi.status = 'issued' THEN 'issued'
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
  'FE-friendly projection of billing_invoices with derived joins/counters and canonical billing_invoice_status payment projection. Current statuses: draft, issued, overdue, paid, void. Read-only; SSOT remains billing_invoices; mutations go through create_billing_invoice_v1 / update_billing_invoice_v1 / billing_invoice_send_v1 / billing_invoice_refund_v1 / void_billing_invoice_v1.';

REVOKE ALL ON public.v_billing_invoice_directory FROM PUBLIC;
REVOKE ALL ON public.v_billing_invoice_directory FROM anon;
REVOKE ALL ON public.v_billing_invoice_directory FROM authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605031680_billing_invoice_directory_status_repair_v1'));
COMMIT;
