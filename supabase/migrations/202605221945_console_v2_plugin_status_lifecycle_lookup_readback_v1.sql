-- Console V2 plugin lifecycle status lookup readback.
-- Keeps live lookup_values aligned with the frontend row-driven plugin
-- lifecycle policy used by Integrations Catalog drawers and cards.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605221945_console_v2_plugin_status_lifecycle_lookup_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  scope_type
)
VALUES (
  'plugin_status',
  'Integration plugin and plugin-version lifecycle statuses.',
  'platform',
  'platform_owned',
  FALSE,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    scope_type = EXCLUDED.scope_type,
    updated_at = now();

WITH def AS (
  SELECT id FROM public.lookup_definitions WHERE category = 'plugin_status'
),
rows(value, label, sort_order, metadata) AS (
  VALUES
    ('active', 'Active', 10, jsonb_build_object('tone', 'good', 'next_actions', jsonb_build_array('set_binding'), 'is_chip_visible', TRUE)),
    ('pending', 'Pending', 20, jsonb_build_object('tone', 'info', 'next_actions', jsonb_build_array(), 'is_chip_visible', FALSE)),
    ('degraded', 'Degraded', 30, jsonb_build_object('tone', 'warn', 'next_actions', jsonb_build_array(), 'is_chip_visible', FALSE)),
    ('rollback', 'Rolled back', 40, jsonb_build_object('tone', 'danger', 'next_actions', jsonb_build_array(), 'is_chip_visible', FALSE)),
    ('disabled', 'Disabled', 50, jsonb_build_object('tone', 'neutral', 'next_actions', jsonb_build_array(), 'is_chip_visible', FALSE)),
    ('draft', 'Draft', 60, jsonb_build_object('tone', 'neutral', 'next_actions', jsonb_build_array('submit'), 'is_chip_visible', FALSE)),
    ('rejected', 'Rejected', 70, jsonb_build_object('tone', 'danger', 'next_actions', jsonb_build_array('submit'), 'is_chip_visible', FALSE)),
    ('submitted', 'Submitted', 80, jsonb_build_object('tone', 'info', 'next_actions', jsonb_build_array('approve', 'reject'), 'is_chip_visible', FALSE)),
    ('approved', 'Approved', 90, jsonb_build_object('tone', 'good', 'next_actions', jsonb_build_array('activate'), 'is_chip_visible', FALSE)),
    ('archived', 'Archived', 100, jsonb_build_object('tone', 'neutral', 'next_actions', jsonb_build_array(), 'is_chip_visible', TRUE)),
    ('pending_review', 'Pending review', 110, jsonb_build_object('tone', 'warn', 'next_actions', jsonb_build_array('approve', 'reject'), 'is_chip_visible', TRUE))
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  status,
  metadata,
  effective_from
)
SELECT
  def.id,
  rows.value,
  rows.label,
  rows.sort_order,
  'active',
  rows.metadata,
  now()
FROM def
CROSS JOIN rows
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = EXCLUDED.metadata,
    effective_until = NULL,
    retired_at = NULL,
    updated_at = now();

SELECT pg_advisory_unlock(hashtext('202605221945_console_v2_plugin_status_lifecycle_lookup_readback_v1'));
COMMIT;
