-- Migration: keep billing refund action aligned with backend lifecycle.
--
-- billing_invoice_refund_v1 supports issued, overdue, and paid invoices when
-- they have a positive amount_paid. Console gates the row-level amount in the
-- component, while lookup metadata owns the status-level capability.

BEGIN;

UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{allows_refund}', 'true'::jsonb, true),
    updated_at = now()
FROM public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category IN ('invoice_status', 'billing_invoice_status')
  AND lv.value IN ('issued', 'overdue', 'paid');

UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{allows_refund}', 'false'::jsonb, true),
    updated_at = now()
FROM public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category IN ('invoice_status', 'billing_invoice_status')
  AND lv.value IN ('draft', 'sent', 'void', 'voided', 'refunded');

WITH event_rows(value, label, tone, sort_order) AS (
  VALUES
    ('billing_invoice.created', 'Created', 'info', 11),
    ('billing_invoice.issued', 'Issued', 'good', 24),
    ('billing_invoice.updated', 'Updated', 'info', 26),
    ('billing_invoice.refunded', 'Refunded', 'neutral', 52),
    ('billing_invoice.voided', 'Voided', 'neutral', 82)
)
INSERT INTO public.lookup_values (lookup_definition_id, value, label, sort_order, metadata)
SELECT ld.id,
       er.value,
       er.label,
       er.sort_order,
       jsonb_build_object('tone', er.tone)
FROM public.lookup_definitions ld
CROSS JOIN event_rows er
WHERE ld.category = 'billing_invoice_event_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

COMMIT;
