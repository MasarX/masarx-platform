-- Test Suite: Mobile V2 policy categories pack (foundation)
-- Validates that the 10 mobile_v2 policy categories registered by
-- 202605101200_mobile_v2_policy_categories_pack_v1 are:
--   (a) present in settings_category_registry with correct flags
--   (b) present in schema_registry with active v1 schemas
--   (c) seeded with a global default in settings_versions
--   (d) cached in settings (cached_value mirrors versioned value)
--   (e) resolvable via the generic resolve_settings_row_from_policy_context_v1
--       at global scope (no tenant/client context)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(50);

-- ----------------------------------------------------------------------------
-- (a) Category registry — 10 categories registered with correct flags
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_pre_shift_gate_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_pre_shift_gate_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_pod_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_pod_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_loader_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_loader_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_pickup_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_pickup_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_linehaul_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_linehaul_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_sortation_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_sortation_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_cash_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_cash_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_tasks_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_tasks_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_returns_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_returns_policy category registered'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'mobile_eor_policy'
      AND requires_schema AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
      AND resource_scope_rel = 'public.branches'::regclass
  ),
  'mobile_eor_policy category registered'
);

-- ----------------------------------------------------------------------------
-- (b) Schema registry — active v1 schemas for each category
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_pre_shift_gate_policy' AND version = 1 AND is_active),
  'mobile_pre_shift_gate_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_pod_policy' AND version = 1 AND is_active),
  'mobile_pod_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_loader_policy' AND version = 1 AND is_active),
  'mobile_loader_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_pickup_policy' AND version = 1 AND is_active),
  'mobile_pickup_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_linehaul_policy' AND version = 1 AND is_active),
  'mobile_linehaul_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_sortation_policy' AND version = 1 AND is_active),
  'mobile_sortation_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_cash_policy' AND version = 1 AND is_active),
  'mobile_cash_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_tasks_policy' AND version = 1 AND is_active),
  'mobile_tasks_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_returns_policy' AND version = 1 AND is_active),
  'mobile_returns_policy schema v1 active'
);
SELECT ok(
  EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'mobile_eor_policy' AND version = 1 AND is_active),
  'mobile_eor_policy schema v1 active'
);

-- ----------------------------------------------------------------------------
-- (c) settings_versions — global default present and approved
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_pre_shift_gate_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND value->>'version' = '1'
  ),
  'mobile_pre_shift_gate_policy has approved global default in settings_versions'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_pod_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND jsonb_array_length(value->'fail_reasons') >= 4
  ),
  'mobile_pod_policy has approved global default with >=4 fail reasons'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_loader_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND jsonb_array_length(value->'actions') >= 6
      AND value->>'default_mode' IN ('single', 'bulk')
  ),
  'mobile_loader_policy has approved global default with >=6 actions and valid default_mode'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_pickup_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND (value->>'seal_required')::boolean = TRUE
  ),
  'mobile_pickup_policy has approved global default with seal_required=true'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_linehaul_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND jsonb_array_length(value->'stages') = 8
  ),
  'mobile_linehaul_policy has approved global default with 8 stages'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_sortation_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND value->>'bay_resolution' IN ('per_route', 'per_destination_zone', 'per_hub_static')
  ),
  'mobile_sortation_policy has approved global default with valid bay_resolution'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_cash_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND value->>'currency' = 'SAR'
      AND (value->>'drop_threshold')::numeric > 0
      AND (value->>'per_stop_cap')::numeric > 0
  ),
  'mobile_cash_policy has approved global default with SAR currency and positive thresholds'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_tasks_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND value->>'default_view' IN ('list', 'board', 'map')
  ),
  'mobile_tasks_policy has approved global default with valid default_view'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_returns_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND (value->>'parcel_level_confirm_required')::boolean = TRUE
  ),
  'mobile_returns_policy has approved global default with parcel_level_confirm_required=true'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'mobile_eor_policy'
      AND scope_type = 'global'
      AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
      AND jsonb_array_length(value->'cash_settlement_order') >= 4
  ),
  'mobile_eor_policy has approved global default with >=4 cash_settlement_order steps'
);

-- ----------------------------------------------------------------------------
-- (d) settings cache — cached_value mirrors versioned value for each category
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_pre_shift_gate_policy'
      AND s.scope_type = 'global'
      AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND s.cached_value = sv.value
  ),
  'mobile_pre_shift_gate_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_pod_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_pod_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_loader_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_loader_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_pickup_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_pickup_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_linehaul_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_linehaul_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_sortation_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_sortation_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_cash_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_cash_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_tasks_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_tasks_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_returns_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_returns_policy cached_value matches versioned value'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'mobile_eor_policy'
      AND s.scope_type = 'global'
      AND s.cached_value = sv.value
  ),
  'mobile_eor_policy cached_value matches versioned value'
);

-- ----------------------------------------------------------------------------
-- (e) Generic resolver — resolve_settings_row_from_policy_context_v1 returns
--     the global default when no scope-bearing context is provided
-- ----------------------------------------------------------------------------

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_pre_shift_gate_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global'
      AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_pre_shift_gate_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_pod_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_pod_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_loader_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_loader_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_pickup_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_pickup_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_linehaul_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_linehaul_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_sortation_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_sortation_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_cash_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value->>'currency' = 'SAR'
  ),
  'resolve_settings_row_from_policy_context_v1 returns SAR-currency global default for mobile_cash_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_tasks_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value->>'default_view' IN ('list', 'board', 'map')
  ),
  'resolve_settings_row_from_policy_context_v1 returns valid default_view for mobile_tasks_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_returns_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_returns_policy'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.resolve_settings_row_from_policy_context_v1(
      'mobile_eor_policy'::text,
      '{}'::jsonb
    ) r
    WHERE r.scope_type = 'global' AND r.value IS NOT NULL
  ),
  'resolve_settings_row_from_policy_context_v1 returns global default for mobile_eor_policy'
);

SELECT * FROM finish();
ROLLBACK;
