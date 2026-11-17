-- Migration: Geocoding auto-learn default policy fix
-- Purpose:
--   Ensure the global geocoding_policy uses queue_for_review for district
--   so auto_learn_geography enqueues manual review as expected by tests.

BEGIN;

UPDATE settings_versions sv
SET value = jsonb_set(
    sv.value,
    '{auto_learning,components,district,action_lookup}',
    to_jsonb('{{LOOKUP:auto_learn_action.queue_for_review}}'::text),
    TRUE
)
WHERE sv.category = 'geocoding_policy'
  AND sv.scope_type = 'global'
  AND COALESCE(sv.value->'auto_learning'->'components'->'district'->>'action_lookup', '') <> '{{LOOKUP:auto_learn_action.queue_for_review}}';

COMMIT;

