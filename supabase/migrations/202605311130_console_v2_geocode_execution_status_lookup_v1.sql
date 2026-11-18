-- Migration: Console V2 geocode execution status lookups
-- Date: 2026-05-31
-- Purpose:
--   Keep geocoding_attempts execution statuses row-driven for Console readback.
--   The workflow/geocoder ledger writes queued/in_progress/succeeded/failed/
--   skipped/deferred and projection/manual-review variants; Console chips must
--   resolve those from lookup rows.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605311130_console_v2_geocode_execution_status_lookup_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'geocoding_attempt_status',
  'Geocoding execution attempt lifecycle statuses',
  'network',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'geocoding_attempt_status'
   LIMIT 1
),
status_rows AS (
  SELECT *
    FROM (VALUES
      ('succeeded', 'Succeeded', 'Completed with a persisted coordinate.', 11, 'good', TRUE),
      ('failed', 'Failed', 'Provider or policy execution failed.', 21, 'danger', TRUE),
      ('permanently_failed', 'Permanently failed', 'Execution exhausted configured retry paths.', 22, 'danger', TRUE),
      ('skipped', 'Skipped', 'Attempt was skipped by cache, policy, or duplicate protection.', 23, 'neutral', TRUE),
      ('deferred', 'Deferred', 'Attempt was deferred by queue or policy backpressure.', 24, 'warn', FALSE),
      ('queued', 'Queued', 'Attempt is waiting for execution.', 31, 'info', FALSE),
      ('in_progress', 'In progress', 'Attempt is currently executing.', 32, 'info', FALSE),
      ('manual_review', 'Manual review', 'Execution routed to a human geocode review task.', 35, 'warn', FALSE)
    ) AS v(value, label, description, sort_order, tone, terminal)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  d.id,
  s.value,
  s.label,
  s.description,
  s.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'tone', s.tone,
    'terminal', s.terminal,
    'canonical_execution_status', TRUE,
    'source', 'console_v2_geocode_execution_status_lookup_v1'
  )
FROM definition d
CROSS JOIN status_rows s
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       sort_order = EXCLUDED.sort_order,
       status = 'active',
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605311130_console_v2_geocode_execution_status_lookup_v1'));
COMMIT;
