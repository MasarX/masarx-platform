SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'draft'
  ),
  true,
  'invoice_status draft allows the Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'issued'
  ),
  false,
  'invoice_status issued blocks the draft Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'sent'
  ),
  false,
  'invoice_status sent blocks the draft Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'overdue'
  ),
  false,
  'invoice_status overdue blocks the draft Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'draft'
  ),
  true,
  'billing_invoice_status draft allows the Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'issued'
  ),
  false,
  'billing_invoice_status issued blocks the draft Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'sent'
  ),
  false,
  'billing_invoice_status sent blocks the draft Send invoice action'
);

SELECT is(
  (
    SELECT (lv.metadata->>'allows_send')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'overdue'
  ),
  false,
  'billing_invoice_status overdue blocks the draft Send invoice action'
);

SELECT * FROM finish();
ROLLBACK;
