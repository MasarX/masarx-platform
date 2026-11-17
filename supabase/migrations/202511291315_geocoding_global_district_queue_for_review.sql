-- Migration: Enforce geocoding auto-learn district queue_for_review (global)
-- Purpose:
--   Ensure the global geocoding_policy config uses queue_for_review for the
--   district auto-learning component so that auto_learn_geography() will
--   enqueue manual review tasks when policy dictates, matching documented
--   behaviour and integration tests.

BEGIN;

UPDATE settings_versions sv
SET value = jsonb_set(
    COALESCE(sv.value, '{}'::jsonb),
    '{auto_learning,components,district,action_lookup}',
    to_jsonb('{{LOOKUP:auto_learn_action.queue_for_review}}'::text),
    TRUE
)
WHERE sv.category = 'geocoding_policy'
  AND sv.scope_type = 'global';

COMMIT;

