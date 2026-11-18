-- pgTAP: Bank reconciliation match status lookup metadata.
-- The Console V2 Manage matches drawer uses these row-driven lifecycle flags
-- to decide which matches can be reversed by an operator.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'bank_recon_match_status'
  ),
  'bank_recon_match_status lookup definition exists'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_active'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'bank_recon_match_status'
      AND lv.value = 'matched'
  ),
  'true',
  'matched status is active'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'bank_recon_match_status'
      AND lv.value = 'matched'
  ),
  'false',
  'matched status is not terminal'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_active'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'bank_recon_match_status'
      AND lv.value = 'unmatched'
  ),
  'false',
  'unmatched status is not active'
);

SELECT is(
  (
    SELECT lv.metadata ->> 'is_terminal'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'bank_recon_match_status'
      AND lv.value = 'unmatched'
  ),
  'true',
  'unmatched status is terminal'
);

SELECT * FROM finish();
ROLLBACK;
