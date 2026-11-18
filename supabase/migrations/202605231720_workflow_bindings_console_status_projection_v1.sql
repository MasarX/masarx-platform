-- Console V2 workflow binding status projection hardening.
-- The browser-facing workflow_bindings resource uses `status` for operator
-- enabled/disabled controls. Keep configurability posture on its dedicated
-- column so live rows do not render as missing workflow_binding_status values.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605231720_workflow_bindings_console_status_projection_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'workflow_binding_status',
  'Console operator enabled-state values for workflow binding stages.',
  'engineering',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable;

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
  ld.id,
  v.value,
  v.label,
  v.description,
  v.sort_order,
  v.is_default,
  'active',
  v.metadata
FROM public.lookup_definitions ld
JOIN (
  VALUES
    (
      'active',
      'Active',
      'Binding stage is enabled for operator dispatch controls.',
      10,
      TRUE,
      jsonb_build_object(
        'toggle_to', 'disabled',
        'toggle_label', 'Disable',
        'toggle_kind', 'danger',
        'toggle_icon', 'lock',
        'is_enabled', TRUE,
        'is_default', TRUE,
        'action_label', 'Activate',
        'action_icon', 'check',
        'action_kind', 'primary'
      )
    ),
    (
      'paused',
      'Paused',
      'Binding stage is temporarily paused by policy but remains workflow-configurable.',
      20,
      FALSE,
      jsonb_build_object(
        'toggle_to', 'disabled',
        'toggle_label', 'Disable',
        'toggle_kind', 'danger',
        'toggle_icon', 'lock',
        'is_enabled', TRUE,
        'action_label', 'Pause',
        'action_icon', 'lock',
        'action_kind', 'ghost'
      )
    ),
    (
      'disabled',
      'Disabled',
      'Binding stage is disabled for operator dispatch controls.',
      30,
      FALSE,
      jsonb_build_object(
        'toggle_to', 'active',
        'toggle_label', 'Re-enable',
        'toggle_kind', 'primary',
        'toggle_icon', 'check',
        'is_enabled', FALSE,
        'action_label', 'Disable',
        'action_icon', 'lock',
        'action_kind', 'danger'
      )
    )
) AS v(value, label, description, sort_order, is_default, metadata)
  ON ld.category = 'workflow_binding_status'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = EXCLUDED.status,
  metadata = EXCLUDED.metadata;

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'workflow_binding_defaults',
  'Console workflow binding create/edit defaults resolved through the settings ladder.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes;

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'workflow_binding_defaults',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', false,
    'required', jsonb_build_array('default_priority', 'default_stage', 'default_scope_type', 'condition_max_depth'),
    'properties', jsonb_build_object(
      'default_priority', jsonb_build_object('type', 'integer', 'minimum', 0),
      'default_stage', jsonb_build_object('type', 'string', 'minLength', 1),
      'default_scope_type', jsonb_build_object('type', 'string', 'enum', jsonb_build_array('global', 'tenant', 'client', 'sender')),
      'condition_max_depth', jsonb_build_object('type', 'integer', 'minimum', 1)
    )
  ),
  'Workflow binding create/edit defaults for Console V2.',
  jsonb_build_array(jsonb_build_object(
    'default_priority', 10,
    'default_stage', 'default',
    'default_scope_type', 'tenant',
    'condition_max_depth', 3
  )),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active;

WITH payload AS (
  SELECT jsonb_build_object(
    'default_priority', 10,
    'default_stage', 'default',
    'default_scope_type', 'tenant',
    'condition_max_depth', 3
  ) AS value
),
existing AS (
  SELECT sv.id, sv.value
  FROM public.settings_versions sv
  WHERE sv.category = 'workflow_binding_defaults'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
  ORDER BY sv.version DESC, sv.created_at DESC
  LIMIT 1
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
    'workflow_binding_defaults',
    'global',
    NULL::uuid,
    COALESCE((SELECT MAX(version) + 1 FROM public.settings_versions WHERE category = 'workflow_binding_defaults' AND scope_type = 'global' AND scope_id IS NULL), 1),
    payload.value,
    1,
    'Seed Console V2 workflow binding create defaults',
    now(),
    now()
  FROM payload
  WHERE NOT EXISTS (SELECT 1 FROM existing)
  RETURNING id, value
),
selected_version AS (
  SELECT id, value FROM inserted
  UNION ALL
  SELECT id, value FROM existing
  LIMIT 1
),
updated AS (
  UPDATE public.settings s
     SET settings_version_id = selected_version.id,
         cached_value = selected_version.value,
         last_updated = now()
    FROM selected_version
   WHERE s.category = 'workflow_binding_defaults'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   RETURNING s.id
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  'workflow_binding_defaults',
  'global',
  NULL::uuid,
  selected_version.id,
  selected_version.value,
  now()
FROM selected_version
WHERE NOT EXISTS (SELECT 1 FROM updated);

CREATE OR REPLACE VIEW public.workflow_bindings_console_v1
WITH (security_invoker = true) AS
WITH first_stage AS (
  SELECT DISTINCT ON (wbsr.binding_key)
    wbsr.binding_key,
    wbsr.stage_key,
    wbsr.sequence_order,
    wbsr.is_enabled
  FROM public.workflow_binding_stage_registry wbsr
  ORDER BY wbsr.binding_key, wbsr.sequence_order ASC, wbsr.stage_key ASC
),
latest_dispatch AS (
  SELECT DISTINCT ON (wbd.binding_key)
    wbd.binding_key,
    wbd.workflow_template_id,
    wbd.outcome,
    wbd.created_at
  FROM public.workflow_binding_dispatches wbd
  ORDER BY wbd.binding_key, wbd.created_at DESC
)
SELECT
  wbr.binding_key AS id,
  wbr.binding_key,
  regexp_replace(wbr.binding_key, '\.[^.]+$', '') AS event,
  ld.workflow_template_id::text AS template_id,
  ld.workflow_template_id,
  fs.stage_key,
  '{}'::jsonb AS condition,
  COALESCE(fs.sequence_order, 0)::int AS priority,
  CASE
    WHEN COALESCE(fs.is_enabled, true) THEN 'active'
    ELSE 'disabled'
  END AS status,
  COALESCE(fs.is_enabled, true) AS enabled,
  wbr.label,
  wbr.description,
  wbr.resource_type,
  wbr.actor_surface,
  wbr.entrypoint_type,
  wbr.current_execution_kind,
  wbr.configurability_status,
  wbr.owner,
  wbr.migration_phase,
  wbr.is_business_affecting,
  ld.outcome AS last_dispatch_outcome,
  ld.created_at AS last_dispatch_at,
  wbr.created_at,
  wbr.updated_at
FROM public.workflow_binding_registry wbr
LEFT JOIN first_stage fs
  ON fs.binding_key = wbr.binding_key
LEFT JOIN latest_dispatch ld
  ON ld.binding_key = wbr.binding_key;

COMMENT ON VIEW public.workflow_bindings_console_v1 IS
  'Console V2 browser-facing workflow binding projection. The status column is the operator enabled-state lookup (workflow_binding_status active/disabled) derived from the first stage is_enabled flag; configurability_status remains the canonical registry posture column.';

REVOKE ALL ON public.workflow_bindings_console_v1 FROM PUBLIC;
REVOKE ALL ON public.workflow_bindings_console_v1 FROM anon;
GRANT SELECT ON public.workflow_bindings_console_v1 TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605231720_workflow_bindings_console_status_projection_v1'));
COMMIT;
