-- Migration: increase prepare inline progression defaults for fresh label print
-- Purpose:
--  - Let label-job completion nudges bridge the canonical 1s prepare wait instead of falling back to worker cadence.
--  - Keep the latency fix row-driven through label_print_policy defaults with no print-only hardcoded branch.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603062410_label_print_prepare_inline_progress_budget_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH current_global AS (
  SELECT settings_version_id
  FROM public.settings
  WHERE category = 'label_print_policy'
    AND scope_type = 'global'
    AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY last_updated DESC
  LIMIT 1
),
updated_version AS (
  UPDATE public.settings_versions sv
  SET value = jsonb_set(
        jsonb_set(
          COALESCE(sv.value, '{}'::jsonb),
          '{prepare_inline_progress_budget_ms}',
          to_jsonb(
            GREATEST(
              COALESCE(NULLIF((sv.value->>'prepare_inline_progress_budget_ms')::int, 0), 0),
              1250
            )
          ),
          true
        ),
        '{prepare_inline_progress_max_steps}',
        to_jsonb(
          GREATEST(
            COALESCE(NULLIF((sv.value->>'prepare_inline_progress_max_steps')::int, 0), 0),
            12
          )
        ),
        true
      ),
      change_reason = 'Increase prepare inline progression defaults so fresh label completion nudges bridge 1s waits',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM current_global cg
  WHERE sv.id = cg.settings_version_id
  RETURNING sv.id, sv.value
)
UPDATE public.settings s
SET cached_value = uv.value,
    last_updated = workflow_now()
FROM updated_version uv
WHERE s.category = 'label_print_policy'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND s.settings_version_id = uv.id;

SELECT pg_advisory_unlock(hashtext('202603062410_label_print_prepare_inline_progress_budget_v2'));
COMMIT;
