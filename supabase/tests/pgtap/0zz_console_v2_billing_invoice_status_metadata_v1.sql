BEGIN;

SELECT plan(18);

SELECT is(
  (
    SELECT metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'draft'
  ),
  'working',
  'invoice_status draft lifecycle is working'
);

SELECT is(
  (
    SELECT (metadata->>'allows_void')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'draft'
  ),
  true,
  'invoice_status draft allows void'
);

SELECT is(
  (
    SELECT (metadata->>'is_draft')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'draft'
  ),
  true,
  'invoice_status draft carries is_draft'
);

SELECT is(
  (
    SELECT (metadata->>'allows_void')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'issued'
  ),
  false,
  'invoice_status issued does not allow void'
);

SELECT is(
  (
    SELECT (metadata->>'allows_mark_paid')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'issued'
  ),
  true,
  'invoice_status issued allows payment recording'
);

SELECT is(
  (
    SELECT (metadata->>'allows_mark_paid')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'overdue'
  ),
  true,
  'invoice_status overdue allows payment recording'
);

SELECT is(
  (
    SELECT (metadata->>'allows_refund')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'paid'
  ),
  true,
  'invoice_status paid allows refund'
);

SELECT is(
  (
    SELECT metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'void'
  ),
  'void',
  'invoice_status void lifecycle is terminal void'
);

SELECT is(
  (
    SELECT (metadata->>'allows_void')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'draft'
  ),
  true,
  'billing_invoice_status draft allows void'
);

SELECT is(
  (
    SELECT (metadata->>'allows_void')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'issued'
  ),
  false,
  'billing_invoice_status issued does not allow void'
);

SELECT is(
  (
    SELECT (metadata->>'is_issued')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'issued'
  ),
  true,
  'billing_invoice_status issued carries is_issued'
);

SELECT is(
  (
    SELECT (metadata->>'allows_mark_paid')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'issued'
  ),
  true,
  'billing_invoice_status issued allows payment recording'
);

SELECT is(
  (
    SELECT (metadata->>'allows_mark_paid')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'overdue'
  ),
  true,
  'billing_invoice_status overdue allows payment recording'
);

SELECT is(
  (
    SELECT metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'billing_invoice_status'
      AND lv.value = 'void'
  ),
  'void',
  'billing_invoice_status void lifecycle is terminal void'
);

SELECT is(
  (
    SELECT metadata->>'tone'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'overdue'
  ),
  'danger',
  'invoice_status overdue keeps danger tone'
);

SELECT is(
  (
    SELECT (metadata->>'is_overdue')::boolean
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'overdue'
  ),
  true,
  'invoice_status overdue carries is_overdue'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'sent'
      AND (lv.metadata->>'is_issued')::boolean
  ),
  'invoice_status sent compatibility row carries issued semantics'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'invoice_status'
      AND lv.value = 'voided'
      AND lv.metadata->>'lifecycle' = 'void'
  ),
  'invoice_status voided compatibility row carries void semantics'
);

SELECT * FROM finish();

ROLLBACK;
