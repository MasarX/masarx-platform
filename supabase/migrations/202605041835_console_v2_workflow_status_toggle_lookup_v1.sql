-- Console V2 workflow template status actions are row-driven from workflow_status.
-- Seeds the canonical toggle metadata used by the template studio top bar.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041835_console_v2_workflow_status_toggle_lookup_v1'));

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
  'workflow_status',
  'Workflow template status',
  'engineering',
  'tier_1',
  false,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = COALESCE(public.lookup_definitions.description, EXCLUDED.description),
    owner_role = COALESCE(public.lookup_definitions.owner_role, EXCLUDED.owner_role),
    approval_policy = COALESCE(public.lookup_definitions.approval_policy, EXCLUDED.approval_policy),
    is_mutable = false,
    updated_at = DEFAULT;

WITH definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'workflow_status'
   ORDER BY created_at ASC
   LIMIT 1
),
rows(value, label, tone, sort_order, metadata) AS (
  VALUES
    ('draft', 'Draft', 'neutral', 10, '{"toggle_to":"active","toggle_label":"Activate","toggle_kind":"primary","toggle_icon":"check"}'::jsonb),
    ('active', 'Active', 'good', 20, '{"toggle_to":"inactive","toggle_label":"Deactivate","toggle_kind":"danger","toggle_icon":"lock"}'::jsonb),
    ('inactive', 'Inactive', 'neutral', 30, '{"toggle_to":"active","toggle_label":"Activate","toggle_kind":"primary","toggle_icon":"check"}'::jsonb),
    ('retired', 'Retired', 'warn', 40, '{"toggle_to":"active","toggle_label":"Activate","toggle_kind":"primary","toggle_icon":"check"}'::jsonb)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  sort_order,
  status,
  metadata
)
SELECT
  definition.id,
  rows.value,
  rows.label,
  rows.sort_order,
  'active',
  rows.metadata || jsonb_build_object('tone', rows.tone)
FROM definition
CROSS JOIN rows
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = DEFAULT,
    archived_at = NULL,
    retired_at = NULL;

SELECT pg_advisory_unlock(hashtext('202605041835_console_v2_workflow_status_toggle_lookup_v1'));

COMMIT;
