-- Migration: Keep Console Billing "Send invoice" action scoped to draft invoices.
--
-- Re-issue/resend is not a complete operator workflow yet. The frontend reads
-- invoice_status.metadata.allows_send, so issued/overdue rows must not expose
-- the draft send action as if it performed a new lifecycle transition.

BEGIN;

UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{allows_send}', 'false'::jsonb, true),
    updated_at = now()
FROM public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category IN ('invoice_status', 'billing_invoice_status')
  AND lv.value IN ('issued', 'sent', 'overdue');

UPDATE public.lookup_values lv
SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{allows_send}', 'true'::jsonb, true),
    updated_at = now()
FROM public.lookup_definitions ld
WHERE ld.id = lv.lookup_definition_id
  AND ld.category IN ('invoice_status', 'billing_invoice_status')
  AND lv.value = 'draft';

COMMIT;
