SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_event_type'
      AND lv.value = 'billing_invoice.created'
  ),
  'Created',
  'billing invoice created event has a visible label'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_event_type'
      AND lv.value = 'billing_invoice.issued'
  ),
  'Issued',
  'billing invoice issued event has a visible label'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_event_type'
      AND lv.value = 'billing_invoice.updated'
  ),
  'Updated',
  'billing invoice updated event has a visible label'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_event_type'
      AND lv.value = 'billing_invoice.refunded'
  ),
  'Refunded',
  'billing invoice refunded event has a visible label'
);

SELECT is(
  (
    SELECT lv.label
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_event_type'
      AND lv.value = 'billing_invoice.voided'
  ),
  'Voided',
  'billing invoice voided event has a visible label'
);

SELECT * FROM finish();
ROLLBACK;
