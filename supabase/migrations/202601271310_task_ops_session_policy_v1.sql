-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Task ops-session policy v1 (row-driven session requirements)
-- Date: 2026-01-27
--
-- Why:
--   - Enforce execution provenance for high-risk operational tasks (COD handover/count, deposit slip creation)
--     using ops_sessions (driver_shift / branch_cash_drawer).
--   - Keep it configuration-driven: requirements live in settings rows (ladder-resolved); RPCs do not hardcode task keys.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601271310_task_ops_session_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Settings category + schema: task_ops_session_policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'task_ops_session_policy',
  'Policy mapping task_type_key to required ops_session session_type (for specific transitions). Ladder-resolved; branch/resource-aware.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    resource_scope_rel = EXCLUDED.resource_scope_rel;

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'task_ops_session_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'defaults', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'required_on_statuses', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
          'require_branch_match', jsonb_build_object('type', 'boolean')
        )
      ),
      'task_type_map', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'description', 'Map of task_type_key -> session requirement',
        'properties', jsonb_build_object()
      )
    )
  ),
  'Task ops session policy. Declares which task types require ops_session provenance (and the expected session_type) for configured transitions.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object(
        'required_on_statuses', jsonb_build_array('completed'),
        'require_branch_match', true
      ),
      'task_type_map', jsonb_build_object(
        'cod_cash_handover', jsonb_build_object('required_session_type', 'driver_shift'),
        'cod_cashier_count', jsonb_build_object('required_session_type', 'branch_cash_drawer'),
        'bank_deposit_slip_create', jsonb_build_object('required_session_type', 'branch_cash_drawer')
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-------------------------------------------------------------------------------
-- 2) Seed global defaults (safe: requirements are data; enforcement is in RPC)
-------------------------------------------------------------------------------

WITH payload AS (
  SELECT jsonb_build_object(
    'version', 1,
    'defaults', jsonb_build_object(
      'required_on_statuses', jsonb_build_array('completed'),
      'require_branch_match', TRUE
    ),
    'task_type_map', jsonb_build_object(
      'cod_cash_handover', jsonb_build_object('required_session_type', 'driver_shift'),
      'cod_cashier_count', jsonb_build_object('required_session_type', 'branch_cash_drawer'),
      'bank_deposit_slip_create', jsonb_build_object('required_session_type', 'branch_cash_drawer')
    )
  ) AS value
),
inserted AS (
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
    'task_ops_session_policy',
    'global',
    NULL::uuid,
    1,
    payload.value,
    1,
    'Seed global task_ops_session_policy',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'task_ops_session_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_id IS NULL
  )
  RETURNING id, value
)
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  'task_ops_session_policy',
  'global',
  NULL::uuid,
  inserted.id,
  inserted.value,
  now()
FROM inserted
ON CONFLICT (category, scope_type, scope_hash)
DO NOTHING;

SELECT pg_advisory_unlock(hashtext('202601271310_task_ops_session_policy_v1'));
COMMIT;

