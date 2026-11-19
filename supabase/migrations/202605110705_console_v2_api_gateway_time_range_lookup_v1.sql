-- Console V2 API gateway time-window lookup repair.
--
-- The API gateway operator surface reads time-window chips from the canonical
-- lookup catalog. Drifted live databases can miss `time_range_options`, which
-- leaves operators unable to widen the backend-backed request window by clicks.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110705_console_v2_api_gateway_time_range_lookup_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'time_range_options',
  'Insights time-window taxonomy with metadata.window_ms for Console V2 filters.',
  'engineering',
  'tier_1',
  false
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      ('5m', '5m', 'Last 5 minutes.', 10, false, jsonb_build_object('window_ms', 300000)),
      ('1h', '1h', 'Last 1 hour.', 20, true, jsonb_build_object('window_ms', 3600000)),
      ('24h', '24h', 'Last 24 hours.', 30, false, jsonb_build_object('window_ms', 86400000)),
      ('7d', '7d', 'Last 7 days.', 40, false, jsonb_build_object('window_ms', 604800000)),
      ('all', 'All', 'All visible records.', 99, false, jsonb_build_object('window_ms', NULL))
  ) AS v(value, label, description, sort_order, is_default, metadata)
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
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r ON d.category = 'time_range_options'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = EXCLUDED.metadata,
  updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605110705_console_v2_api_gateway_time_range_lookup_v1'));

COMMIT;
