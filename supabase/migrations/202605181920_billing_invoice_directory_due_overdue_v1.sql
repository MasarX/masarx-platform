-- Migration: keep Billing overdue projection tied to real amount due.
--
-- Operator overdue queues and KPIs must represent collectible receivables.
-- Past-due issued invoices with zero backend amount_due are not actionable
-- overdue debt and must stay out of the overdue projection.

BEGIN;

CREATE OR REPLACE VIEW public.v_billing_invoice_directory
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
),
invoice_base AS (
  SELECT
    bi.*,
    GREATEST(
      0,
      COALESCE(
        bi.amount_due,
        bi.total - COALESCE(bi.amount_paid, 0),
        bi.total,
        0
      )
    )::NUMERIC AS outstanding_amount
  FROM public.billing_invoices bi
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
    bi.outstanding_amount > 0
    AND (
      bi.status = 'overdue'
      OR (bi.status IN ('issued', 'sent') AND bi.due_at IS NOT NULL AND now() > bi.due_at)
    )
  ) AS is_overdue,
  CASE
    WHEN bi.status = 'refunded' THEN 'refunded'
    WHEN bi.status IN ('void', 'voided') THEN 'void'
    WHEN bi.outstanding_amount > 0 AND bi.status = 'overdue' THEN 'overdue'
    WHEN bi.outstanding_amount > 0 AND bi.status IN ('issued', 'sent') AND bi.due_at IS NOT NULL AND now() > bi.due_at THEN 'overdue'
    WHEN bi.paid_at IS NOT NULL THEN 'paid'
    WHEN bi.status IN ('issued', 'sent', 'overdue') THEN 'issued'
    ELSE 'draft'
  END AS payment_status,
  GREATEST(0, EXTRACT(DAY FROM (now() - bi.created_at)))::INT AS age_days
FROM invoice_base bi
LEFT JOIN public.clients c   ON c.id = bi.client_id
LEFT JOIN public.senders s   ON s.id = bi.sender_id
LEFT JOIN line_agg           ON line_agg.invoice_id = bi.id
LEFT JOIN event_agg          ON event_agg.invoice_id = bi.id
LEFT JOIN event_sent         ON event_sent.invoice_id = bi.id
LEFT JOIN event_refunded     ON event_refunded.invoice_id = bi.id
LEFT JOIN event_voided       ON event_voided.invoice_id = bi.id;

COMMENT ON VIEW public.v_billing_invoice_directory IS
  'FE-friendly projection of billing_invoices with derived joins/counters and amount-due-aware canonical billing_invoice_status payment projection. Current statuses: draft, issued, overdue, paid, refunded, void. Read-only; SSOT remains billing_invoices; mutations go through create_billing_invoice_v1 / update_billing_invoice_v1 / billing_invoice_send_v1 / billing_invoice_refund_v1 / void_billing_invoice_v1.';

REVOKE ALL ON public.v_billing_invoice_directory FROM PUBLIC;
REVOKE ALL ON public.v_billing_invoice_directory FROM anon;
REVOKE ALL ON public.v_billing_invoice_directory FROM authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO authenticated;
GRANT SELECT ON public.v_billing_invoice_directory TO service_role;

COMMIT;
