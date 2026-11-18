SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT is(
  (
    SELECT lv.metadata->>'target_rpc'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispute_resolution'
      AND lv.value = 'credit'
  ),
  'marketplace_dispute_resolution_v1',
  'dispute_resolution.credit targets marketplace dispute resolution RPC'
);

SELECT ok(
  (
    SELECT (lv.metadata->>'requires_notes')::boolean = true
      AND lv.metadata->>'target_rpc' = 'dispute_reject_v1'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispute_resolution'
      AND lv.value = 'reject'
  ),
  'dispute_resolution.reject targets reject RPC and requires operator notes'
);

SELECT ok(
  (
    SELECT (lv.metadata->>'requires_amount')::boolean = true
      AND lv.metadata->>'target_rpc' = 'marketplace_dispute_resolution_v1'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'dispute_resolution'
      AND lv.value = 'partial'
  ),
  'dispute_resolution.partial requires amount and targets resolution RPC'
);

SELECT * FROM finish();
ROLLBACK;
