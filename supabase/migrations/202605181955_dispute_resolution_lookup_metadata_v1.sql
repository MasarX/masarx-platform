-- Migration: make dispute resolution lookup rows carry UI action metadata.
--
-- Console V2 dispute resolution must be row-driven in live DB mode. The
-- frontend uses this metadata to decide which canonical backend action to
-- call and which operator inputs are mandatory before allowing submission.

BEGIN;

WITH target_definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'dispute_resolution'
)
UPDATE public.lookup_values lv
SET
  metadata = COALESCE(lv.metadata, '{}'::jsonb) || CASE lv.value
    WHEN 'credit' THEN jsonb_build_object(
      'target_rpc', 'marketplace_dispute_resolution_v1',
      'requires_amount', false,
      'requires_notes', false
    )
    WHEN 'reject' THEN jsonb_build_object(
      'target_rpc', 'dispute_reject_v1',
      'requires_amount', false,
      'requires_notes', true
    )
    WHEN 'partial' THEN jsonb_build_object(
      'target_rpc', 'marketplace_dispute_resolution_v1',
      'requires_amount', true,
      'requires_notes', false
    )
    ELSE '{}'::jsonb
  END,
  updated_at = now()
FROM target_definition td
WHERE lv.lookup_definition_id = td.id
  AND lv.value IN ('credit', 'reject', 'partial');

COMMIT;
