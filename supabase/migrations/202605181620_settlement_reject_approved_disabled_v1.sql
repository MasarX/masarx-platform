-- Migration: keep settlement reject action aligned with backend lifecycle.
--
-- reject_settlement_v1 only supports open/locked batches. Approved batches are
-- ready for posting, not rejection, so Console action metadata must not expose
-- Reject in that state.

BEGIN;

UPDATE public.lookup_values lv
   SET metadata = jsonb_set(COALESCE(lv.metadata, '{}'::jsonb), '{allows_reject}', 'false'::jsonb, true),
       updated_at = now()
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'settlement_status'
   AND lv.value = 'approved';

COMMIT;
