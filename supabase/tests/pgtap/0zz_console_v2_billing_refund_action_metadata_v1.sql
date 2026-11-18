SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(12);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'issued'
  ),
  true,
  'invoice_status issued exposes refund when the row has amount_paid'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'overdue'
  ),
  true,
  'invoice_status overdue exposes refund when the row has amount_paid'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'paid'
  ),
  true,
  'invoice_status paid exposes refund'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'sent'
  ),
  false,
  'invoice_status sent stays non-refundable because the refund RPC does not accept sent'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'draft'
  ),
  false,
  'invoice_status draft blocks refund'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'refunded'
  ),
  false,
  'invoice_status refunded blocks repeat refund'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'issued'
  ),
  true,
  'billing_invoice_status issued exposes refund when the row has amount_paid'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'overdue'
  ),
  true,
  'billing_invoice_status overdue exposes refund when the row has amount_paid'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'paid'
  ),
  true,
  'billing_invoice_status paid exposes refund'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'sent'
  ),
  false,
  'billing_invoice_status sent stays non-refundable because the refund RPC does not accept sent'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'draft'
  ),
  false,
  'billing_invoice_status draft blocks refund'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'refunded'
  ),
  false,
  'billing_invoice_status refunded blocks repeat refund'
);

SELECT * FROM finish();
ROLLBACK;
