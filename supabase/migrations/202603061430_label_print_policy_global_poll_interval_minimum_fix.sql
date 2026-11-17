-- Migration: normalize label_print_policy global poll interval to schema minimum
-- Plan: PLAN-202603-go-live-readiness-remediation-v4 / Step: S04
-- Purpose:
--  - Repair drift where active global label_print_policy.poll_interval_seconds can be
--    lower than schema minimum (5), causing fail-closed verification failures.
-- Notes:
--  - Row-driven and idempotent.
--  - Updates only the active global settings row for label_print_policy.

BEGIN;

SET search_path TO public, workflow_handlers, pg_temp;

WITH active_global AS (
  SELECT s.settings_version_id
  FROM public.settings s
  WHERE s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY s.last_updated DESC
  LIMIT 1
),
normalized AS (
  SELECT
    sv.id AS settings_version_id,
    jsonb_set(
      COALESCE(sv.value, '{}'::jsonb),
      '{poll_interval_seconds}',
      to_jsonb(
        GREATEST(
          COALESCE(
            CASE
              WHEN btrim(COALESCE(sv.value->>'poll_interval_seconds', '')) ~ '^[0-9]+$'
                THEN (sv.value->>'poll_interval_seconds')::int
              ELSE NULL
            END,
            60
          ),
          5
        )
      ),
      true
    ) AS next_value
  FROM public.settings_versions sv
  JOIN active_global ag
    ON ag.settings_version_id = sv.id
),
updated_versions AS (
  UPDATE public.settings_versions sv
  SET value = n.next_value,
      change_reason = 'Normalize label_print_policy.poll_interval_seconds to schema minimum (>=5)',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  FROM normalized n
  WHERE sv.id = n.settings_version_id
    AND (
      NOT (sv.value ? 'poll_interval_seconds')
      OR NOT (btrim(COALESCE(sv.value->>'poll_interval_seconds', '')) ~ '^[0-9]+$')
      OR (
        btrim(COALESCE(sv.value->>'poll_interval_seconds', '')) ~ '^[0-9]+$'
        AND (sv.value->>'poll_interval_seconds')::int < 5
      )
    )
  RETURNING sv.id, sv.value
),
applied AS (
  UPDATE public.settings s
  SET cached_value = uv.value,
      last_updated = workflow_now()
  FROM updated_versions uv
  WHERE s.settings_version_id = uv.id
    AND s.category = 'label_print_policy'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  RETURNING s.id
)
SELECT 'label_print_policy global poll interval normalized' AS status;

COMMIT;
