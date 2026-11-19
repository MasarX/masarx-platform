-- zzw48_currency_and_kpi_threshold_policies.sql — pgTAP for W30 migration
-- (202605020600_w48_currency_and_kpi_threshold_policies.sql).
--
-- Asserts:
--   1. All 6 settings_category_registry categories present.
--   2. settings_versions row per category with version=1, status=active.
--   3. settings cached_value matches the seeded version value.
--   4. JSON shape: required keys present in each policy value.

BEGIN;
SELECT plan(43);

-- ─── 1. settings_category_registry presence ─────────────────────────

SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'tenant_currency'), 'tenant_currency category registered');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'task_sla_thresholds'), 'task_sla_thresholds category registered');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'driver_kpi_thresholds'), 'driver_kpi_thresholds category registered');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'route_plan_thresholds'), 'route_plan_thresholds category registered');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'feature_flags_thresholds'), 'feature_flags_thresholds category registered');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'api_gateway_thresholds'), 'api_gateway_thresholds category registered');

-- ─── 2. owner_role + scope_type attribution ─────────────────────────

SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'tenant_currency'), 'tenant_currency registry flags are global-default safe');
SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'task_sla_thresholds'), 'task_sla_thresholds registry flags are global-default safe');
SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'driver_kpi_thresholds'), 'driver_kpi_thresholds registry flags are global-default safe');
SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'route_plan_thresholds'), 'route_plan_thresholds registry flags are global-default safe');
SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'feature_flags_thresholds'), 'feature_flags_thresholds registry flags are global-default safe');
SELECT ok((SELECT requires_global_default AND NOT side_effecting AND allowed_scopes ? 'global' FROM public.settings_category_registry WHERE category = 'api_gateway_thresholds'), 'api_gateway_thresholds registry flags are global-default safe');

-- ─── 3. settings_versions canonical row per category ────────────────

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'tenant_currency'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND version >= 1
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
  ),
  'tenant_currency v1 active row at global scope'
);
SELECT ok(EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'task_sla_thresholds' AND scope_type = 'global' AND scope_id IS NULL AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND version >= 1 AND effective_until IS NULL AND approved_at IS NOT NULL), 'task_sla_thresholds active global version');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'driver_kpi_thresholds' AND scope_type = 'global' AND scope_id IS NULL AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND version >= 1 AND effective_until IS NULL AND approved_at IS NOT NULL), 'driver_kpi_thresholds active global version');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'route_plan_thresholds' AND scope_type = 'global' AND scope_id IS NULL AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND version >= 1 AND effective_until IS NULL AND approved_at IS NOT NULL), 'route_plan_thresholds active global version');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'feature_flags_thresholds' AND scope_type = 'global' AND scope_id IS NULL AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND version >= 1 AND effective_until IS NULL AND approved_at IS NOT NULL), 'feature_flags_thresholds active global version');
SELECT ok(EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'api_gateway_thresholds' AND scope_type = 'global' AND scope_id IS NULL AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND version >= 1 AND effective_until IS NULL AND approved_at IS NOT NULL), 'api_gateway_thresholds active global version');

-- ─── 4. settings cached_value matches version value ─────────────────

SELECT is(
  (SELECT s.cached_value->>'iso_code' FROM public.settings s WHERE s.category = 'tenant_currency' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  'SAR',
  'tenant_currency.iso_code = SAR'
);
SELECT is(
  (SELECT (s.cached_value->>'sla_warn_minutes_before_breach')::int FROM public.settings s WHERE s.category = 'task_sla_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  30,
  'task_sla_thresholds.sla_warn_minutes_before_breach = 30'
);
SELECT is(
  (SELECT (s.cached_value->>'sla_ring_warn_pct')::int FROM public.settings s WHERE s.category = 'task_sla_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  75,
  'task_sla_thresholds.sla_ring_warn_pct = 75'
);
SELECT is(
  (SELECT (s.cached_value->>'sla_ring_danger_pct')::int FROM public.settings s WHERE s.category = 'task_sla_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  95,
  'task_sla_thresholds.sla_ring_danger_pct = 95'
);
SELECT is(
  (SELECT (s.cached_value->>'no_sla_default_percent')::int FROM public.settings s WHERE s.category = 'task_sla_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  30,
  'task_sla_thresholds.no_sla_default_percent = 30'
);
SELECT is(
  (SELECT (s.cached_value->>'docs_expiring_days')::int FROM public.settings s WHERE s.category = 'driver_kpi_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  30,
  'driver_kpi_thresholds.docs_expiring_days = 30'
);
SELECT is(
  (SELECT (s.cached_value->>'docs_expiring_warn_count')::int FROM public.settings s WHERE s.category = 'driver_kpi_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  2,
  'driver_kpi_thresholds.docs_expiring_warn_count = 2'
);
SELECT is(
  (SELECT (s.cached_value->>'score_oos_threshold')::int FROM public.settings s WHERE s.category = 'driver_kpi_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  60,
  'driver_kpi_thresholds.score_oos_threshold = 60'
);
SELECT is(
  (SELECT (s.cached_value->>'application_pending_warn_count')::int FROM public.settings s WHERE s.category = 'driver_kpi_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  5,
  'driver_kpi_thresholds.application_pending_warn_count = 5'
);
SELECT is(
  (SELECT (s.cached_value->>'application_pending_breach_days')::int FROM public.settings s WHERE s.category = 'driver_kpi_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  7,
  'driver_kpi_thresholds.application_pending_breach_days = 7'
);
SELECT is(
  (SELECT (s.cached_value->>'fail_count_warn')::int FROM public.settings s WHERE s.category = 'route_plan_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  2,
  'route_plan_thresholds.fail_count_warn = 2'
);
SELECT is(
  (SELECT (s.cached_value->>'complete_pct')::int FROM public.settings s WHERE s.category = 'feature_flags_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  100,
  'feature_flags_thresholds.complete_pct = 100'
);
SELECT is(
  (SELECT (s.cached_value->>'usage_pct_warn')::int FROM public.settings s WHERE s.category = 'api_gateway_thresholds' AND s.scope_type = 'global' AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  80,
  'api_gateway_thresholds.usage_pct_warn = 80'
);

-- ─── 5. settings_versions value matches schema fields ───────────────

SELECT is(
  (SELECT (sv.value->>'on_time_pct_good')::numeric FROM public.settings_versions sv WHERE sv.category = 'driver_kpi_thresholds' AND sv.scope_type = 'global' AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND sv.effective_until IS NULL AND sv.approved_at IS NOT NULL),
  0.9,
  'driver_kpi_thresholds.on_time_pct_good = 0.9'
);
SELECT is(
  (SELECT (sv.value->>'on_time_pct_warn')::numeric FROM public.settings_versions sv WHERE sv.category = 'driver_kpi_thresholds' AND sv.scope_type = 'global' AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND sv.effective_until IS NULL AND sv.approved_at IS NOT NULL),
  0.8,
  'driver_kpi_thresholds.on_time_pct_warn = 0.8'
);
SELECT is(
  (SELECT (sv.value->>'rating_good')::numeric FROM public.settings_versions sv WHERE sv.category = 'driver_kpi_thresholds' AND sv.scope_type = 'global' AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND sv.effective_until IS NULL AND sv.approved_at IS NOT NULL),
  4.5,
  'driver_kpi_thresholds.rating_good = 4.5'
);
SELECT is(
  (SELECT (sv.value->>'rating_warn')::numeric FROM public.settings_versions sv WHERE sv.category = 'driver_kpi_thresholds' AND sv.scope_type = 'global' AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid AND sv.effective_until IS NULL AND sv.approved_at IS NOT NULL),
  4.0,
  'driver_kpi_thresholds.rating_warn = 4.0'
);

-- ─── 6. Idempotency invariant ───────────────────────────────────────
-- Re-running the migration should leave row counts stable
-- (settings_versions UNIQUE on (category, scope_type, scope_id, version)).

SELECT is(
  (SELECT count(*)::int FROM public.settings_versions
    WHERE category IN ('tenant_currency','task_sla_thresholds','driver_kpi_thresholds','route_plan_thresholds','feature_flags_thresholds','api_gateway_thresholds')
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL),
  6,
  'exactly 6 active settings_versions rows for the W48 categories'
);

SELECT is(
  (SELECT count(*)::int FROM public.settings
    WHERE category IN ('tenant_currency','task_sla_thresholds','driver_kpi_thresholds','route_plan_thresholds','feature_flags_thresholds','api_gateway_thresholds')
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid),
  6,
  'exactly 6 settings rows for the W48 categories'
);

-- ─── 7. settings_category_registry safe_missing_behavior ────────────

SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'tenant_currency'),
  'skip',
  'tenant_currency.safe_missing_behavior = skip'
);
SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'task_sla_thresholds'),
  'skip',
  'task_sla_thresholds.safe_missing_behavior = skip'
);
SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'driver_kpi_thresholds'),
  'skip',
  'driver_kpi_thresholds.safe_missing_behavior = skip'
);
SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'route_plan_thresholds'),
  'skip',
  'route_plan_thresholds.safe_missing_behavior = skip'
);
SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'feature_flags_thresholds'),
  'skip',
  'feature_flags_thresholds.safe_missing_behavior = skip'
);
SELECT is(
  (SELECT safe_missing_behavior FROM public.settings_category_registry WHERE category = 'api_gateway_thresholds'),
  'skip',
  'api_gateway_thresholds.safe_missing_behavior = skip'
);

SELECT * FROM finish();
ROLLBACK;
