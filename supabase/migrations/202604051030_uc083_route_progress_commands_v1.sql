-- Plan: B07 FieldOps driver production baseline / UC083 route progression
-- Migration: Route progress commands v1
-- Purpose:
-- - Add minimal route-stop progression commands to every scoped ui_command_registry row.
-- - Reuse the existing task_transition executor so FieldOps can mark route-stop execution
--   tasks as en_route or arrived without inventing a new backend command surface.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604051030_uc083_route_progress_commands_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH canonical_commands AS (
  SELECT
    1000001::bigint AS ord,
    jsonb_build_object(
      'key', 'tasks.en_route',
      'label', 'En route',
      'description', 'Mark the selected stop as en route.',
      'capability', 'tasks.complete',
      'schema_category', 'resource:tasks',
      'selection', jsonb_build_object('mode', 'single', 'id_param', 'id'),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'params', jsonb_build_object(
          'handler', 'task_transition',
          'to_status', 'in_progress',
          'status_reason', 'en_route'
        )
      )
    ) AS command
  UNION ALL
  SELECT
    1000002::bigint AS ord,
    jsonb_build_object(
      'key', 'tasks.arrived',
      'label', 'Arrived',
      'description', 'Mark the selected stop as arrived.',
      'capability', 'tasks.complete',
      'schema_category', 'resource:tasks',
      'selection', jsonb_build_object('mode', 'single', 'id_param', 'id'),
      'execution', jsonb_build_object(
        'type', 'rpc',
        'rpc', 'ui_execute_command_v1',
        'params', jsonb_build_object(
          'handler', 'task_transition',
          'to_status', 'in_progress',
          'status_reason', 'arrived'
        )
      )
    ) AS command
),
target_rows AS (
  SELECT
    s.id AS settings_id,
    s.settings_version_id,
    sv.version,
    sv.value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_command_registry'
),
rewritten AS (
  SELECT
    tr.settings_id,
    tr.settings_version_id,
    tr.version,
    tr.value,
    jsonb_set(
      tr.value,
      '{commands}',
      COALESCE(
        (
          SELECT jsonb_agg(next_item.command ORDER BY next_item.ord)
          FROM (
            SELECT
              existing.ord::bigint AS ord,
              existing.item AS command
            FROM jsonb_array_elements(COALESCE(tr.value->'commands', '[]'::jsonb))
              WITH ORDINALITY AS existing(item, ord)
            WHERE existing.item->>'key' NOT IN ('tasks.en_route', 'tasks.arrived')

            UNION ALL

            SELECT cc.ord, cc.command
            FROM canonical_commands cc
          ) AS next_item
        ),
        '[]'::jsonb
      ),
      true
    ) AS next_value
  FROM target_rows tr
),
changed AS (
  SELECT
    r.settings_id,
    r.settings_version_id,
    r.version,
    r.next_value
  FROM rewritten r
  WHERE r.next_value IS DISTINCT FROM r.value
),
applied AS (
  UPDATE public.settings_versions sv
     SET value = c.next_value,
         version = COALESCE(c.version, 0) + 1,
         change_reason = 'Add route progress task commands for FieldOps UC083',
         approved_at = now(),
         effective_from = now()
    FROM changed c
   WHERE sv.id = c.settings_version_id
  RETURNING sv.id, sv.value, c.settings_id
)
UPDATE public.settings s
   SET cached_value = a.value,
       last_updated = now()
  FROM applied a
 WHERE s.id = a.settings_id;

SELECT pg_advisory_unlock(hashtext('202604051030_uc083_route_progress_commands_v1'));
COMMIT;
