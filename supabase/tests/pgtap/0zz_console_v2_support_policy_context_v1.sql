-- pgTAP: Console V2 Support profile context policy.
-- Proves support_policy is production-backed so Support profile panels do
-- not silently render empty related shipment/decision context in live mode.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'support_policy'
      AND requires_schema IS TRUE
      AND requires_global_default IS TRUE
      AND side_effecting IS FALSE
      AND allowed_scopes ? 'global'
      AND allowed_scopes ? 'tenant'
  ),
  'support_policy is registered as a safe global-default settings category'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'support_policy'
      AND version = 1
      AND is_active IS TRUE
      AND schema ? 'properties'
  ),
  'support_policy has an active schema_registry row'
);

SELECT is(
  (
    SELECT cached_value->>'recent_shipments_limit'
    FROM public.settings
    WHERE category = 'support_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  '6',
  'support_policy global settings row exposes recent_shipments_limit'
);

SELECT is(
  (
    SELECT cached_value->>'recent_decisions_limit'
    FROM public.settings
    WHERE category = 'support_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  '5',
  'support_policy global settings row exposes recent_decisions_limit'
);

SELECT is(
  (
    SELECT cached_value#>>'{escalation,target_priority}'
    FROM public.settings
    WHERE category = 'support_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'urgent',
  'support_policy global settings row exposes escalation target_priority'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'support_policy'
      AND version = 1
      AND schema#>'{properties,escalation}' IS NOT NULL
  ),
  'support_policy schema includes escalation contract'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    WHERE s.category = 'support_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND sv.value = s.cached_value
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
  ),
  'support_policy settings cache points at the current approved version'
);

SELECT is(
  (
    SELECT (value->>'recent_decisions_limit')
    FROM public.resolve_settings_row_from_policy_context_v1(
      'support_policy',
      jsonb_build_object('organization_id', '00000000-0000-0000-0000-00000000bc01')
    )
    LIMIT 1
  ),
  '5',
  'support_policy resolves through the canonical policy-context resolver'
);

SELECT is(
  (
    SELECT (value#>>'{escalation,decision_category}')
    FROM public.resolve_settings_row_from_policy_context_v1(
      'support_policy',
      jsonb_build_object('organization_id', '00000000-0000-0000-0000-00000000bc01')
    )
    LIMIT 1
  ),
  'support_case.escalate',
  'support_policy escalation settings resolve through the canonical policy-context resolver'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource->'filters', '[]'::jsonb)) filter_row
    WHERE s.category = 'ui_read_registry'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
      AND resource->>'key' = 'decision_log'
      AND filter_row->>'key' = 'resource_id'
      AND filter_row->>'column' = 'resource_id'
      AND filter_row->>'op' = 'eq'
  ),
  'decision_log registry supports scoped resource_id reads for Support context'
);

SELECT * FROM finish();

ROLLBACK;
