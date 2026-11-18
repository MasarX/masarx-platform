-- 202605020600_w48_currency_and_kpi_threshold_policies.sql
-- Backend mirror for the W29 (G1) + W30 (G7) FE seed expansion
-- (apps/console-v2/src/lib/seed-raw/policies.js).
--
-- Closes the last two large gaps in the no-fallback campaign:
--   G1 — service-offerings 11x hardcoded `'SAR'` -> `tenant_currency.iso_code`
--   G7 — KPI threshold magic numbers across operate/workflows/platform/
--        insights -> 5 canonical threshold policy categories.
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adding/changing a threshold is one settings_versions
--      row mutation, no FE source change.
--   §2 ZERO HARDCODING — every monetary default + KPI tone threshold the
--      FE consumes now reads from a canonical settings ladder row.
--   §3 ROW-DRIVEN — values are rows, not literals.
--   §4 SSOT — three-way alignment: this file ↔ FE seed mirror ↔ modules.
--   §5 APPEND-ONLY — new file; W17 / W24c / W47 untouched.

-- ---------------------------------------------------------------------------
-- 1. settings_category_registry — register the new policy categories
-- ---------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  ('tenant_currency',
   'Tenant-scope default ISO currency code (consumed by catalog/service-offerings + any monetary surface). FE renders `''—''` when the canonical row is missing instead of falling back to a hardcoded ISO code.',
   FALSE, TRUE, 'skip', '["global"]'::jsonb),
  ('task_sla_thresholds',
   'Canonical SLA tone thresholds for task surfaces (operate/exceptions chip flips + workflows/review-queue SLA ring percentages).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb),
  ('driver_kpi_thresholds',
   'Driver KPI tone thresholds (docs expiry, OOS score, on-time pct, rating, application pending breach window).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb),
  ('route_plan_thresholds',
   'Route plan validation tone thresholds (fail_count warn boundary).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb),
  ('feature_flags_thresholds',
   'Feature flag rollout completion threshold (% considered complete).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb),
  ('api_gateway_thresholds',
   'API gateway saturation tone threshold (% of quota considered warn).',
   FALSE, TRUE, 'skip', '["global"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. settings_versions — seed canonical global rows
-- ---------------------------------------------------------------------------
-- Pattern mirrors W17 (202605020100_w43_*): direct INSERT keyed on
-- (category, scope_type, scope_id, version) with ON CONFLICT idempotency.

WITH default_payload(category, body) AS (
  VALUES
    ('tenant_currency', '{"iso_code":"SAR"}'::jsonb),
    ('task_sla_thresholds', '{"sla_warn_minutes_before_breach":30,"sla_ring_warn_pct":75,"sla_ring_danger_pct":95,"no_sla_default_percent":30}'::jsonb),
    ('driver_kpi_thresholds', '{"docs_expiring_days":30,"docs_expiring_warn_count":2,"score_oos_threshold":60,"on_time_pct_good":0.9,"on_time_pct_warn":0.8,"rating_good":4.5,"rating_warn":4.0,"application_pending_warn_count":5,"application_pending_breach_days":7}'::jsonb),
    ('route_plan_thresholds', '{"fail_count_warn":2}'::jsonb),
    ('feature_flags_thresholds', '{"complete_pct":100}'::jsonb),
    ('api_gateway_thresholds', '{"usage_pct_warn":80}'::jsonb)
)
INSERT INTO public.settings_versions (
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
SELECT
  dp.category,
  'global',
  NULL::uuid,
  1,
  dp.body,
  1,
  'W48 canonical Console V2 policy seed',
  now(),
  now()
FROM default_payload dp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = dp.category
    AND sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. settings — write the active resolved row(s)
-- ---------------------------------------------------------------------------
-- Mirror of W17 pattern: settings table holds the single resolved
-- "current" value for a (category, scope_type, scope_id) tuple. The
-- W17 migration's seed sets `cached_value = settings_versions.value`.

WITH current_versions AS (
  SELECT DISTINCT ON (sv.category)
    sv.category,
    sv.scope_type,
    sv.scope_id,
    sv.scope_hash,
    sv.id,
    sv.value
  FROM public.settings_versions sv
  WHERE sv.category IN (
    'tenant_currency', 'task_sla_thresholds', 'driver_kpi_thresholds',
    'route_plan_thresholds', 'feature_flags_thresholds', 'api_gateway_thresholds'
  )
    AND sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
  ORDER BY sv.category, sv.version DESC, sv.created_at DESC
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  cv.category,
  cv.scope_type,
  cv.scope_id,
  cv.scope_hash,
  cv.id,
  cv.value,
  now()
FROM current_versions cv
ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;
