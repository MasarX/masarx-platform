-- Console V2 operator routing and fleet user-option permission contract.
--
-- This migration keeps live backend metadata aligned with Console V2:
-- 1) fleet_user_options is a driver-create picker and must require fleet.write;
-- 2) task_type lookup rows carry the operator destination that task row actions
--    use to land on the owning domain surface.

BEGIN;

DO $$
DECLARE
  v_setting RECORD;
  v_next JSONB;
BEGIN
  FOR v_setting IN
    SELECT id, settings_version_id, COALESCE(cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings
     WHERE category = 'ui_read_registry'
  LOOP
    SELECT jsonb_set(
      v_setting.cached_value,
      '{resources}',
      COALESCE(
        (
          SELECT jsonb_agg(
                   CASE
                     WHEN resource.value->>'key' = 'fleet_user_options'
                       THEN jsonb_set(resource.value, '{capability_read}', to_jsonb('fleet.write'::text), TRUE)
                     ELSE resource.value
                   END
                   ORDER BY resource.ordinality
                 )
            FROM jsonb_array_elements(COALESCE(v_setting.cached_value->'resources', '[]'::jsonb))
              WITH ORDINALITY AS resource(value, ordinality)
        ),
        '[]'::jsonb
      ),
      TRUE
    )
    INTO v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.id;

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now(),
           change_reason = 'Console V2 fleet_user_options requires fleet.write'
     WHERE id = v_setting.settings_version_id;
  END LOOP;
END;
$$;

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  organization_id,
  scope_type
)
VALUES (
  'task_type',
  'Canonical task type taxonomy with Console V2 tone, reviewer-description, and operator routing metadata.',
  'operations',
  'tier_2',
  FALSE,
  NULL,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    owner_role = EXCLUDED.owner_role,
    approval_policy = EXCLUDED.approval_policy,
    is_mutable = EXCLUDED.is_mutable,
    updated_at = now();

WITH task_type_seed(value, label, sort_order, tone, reviewer_description, console_path, console_focus_param, console_focus_source) AS (
  VALUES
    ('manual_review', 'Manual review', 10, 'neutral',
     'Manual review required. Workflow paused awaiting reviewer decision. Resume via transition_task_v1 with chosen next_status.',
     '/workflows/review-queue', 'focus', 'id'),
    ('dispatch_exception_review', 'Dispatch exception (NDR)', 20, 'warn',
     'Driver attempted delivery and recorded a non-final outcome. Review the resolution policy ladder result and apply the chosen action via apply_dispatch_exception_resolution_v1.',
     '/operate/exceptions', 'task', 'id'),
    ('tenant_signup_review', 'Tenant signup review', 30, 'info',
     'Inbound tenant signup request. Verify business name, billing details, and KYC docs before approval.',
     '/platform/organizations', 'task', 'id'),
    ('shipment_amend_review', 'Shipment amend review', 40, 'warn',
     'Customer-requested shipment amendment. Validate the requested operation against amend policy and approve or reject.',
     '/operate/amend-cancel', 'focus', 'id'),
    ('warehouse_supervisor_approval', 'Warehouse approval', 50, 'info',
     'Warehouse supervisor variance approval. Review variance summary and linked transfer before approve or reject.',
     '/platform/warehouse', 'task', 'id'),
    ('warehouse_scan_supervisor_approval', 'Warehouse scan approval', 60, 'info',
     'Out-of-sequence checkpoint scan correction. Review the scan trail and approve the override.',
     '/platform/warehouse', 'task', 'id'),
    ('route_stop_execute', 'Route stop execute', 70, 'info',
     'Driver-side route stop execution task. Reviewed in the dispatch supervision surface when operators inspect the shipment task relationship.',
     '/operate/dispatch', 'route_stop', 'resource_id')
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
  ld.id,
  seed.value,
  seed.label,
  seed.sort_order,
  'active',
  jsonb_build_object(
    'tone', seed.tone,
    'reviewer_description', seed.reviewer_description,
    'console_path', seed.console_path,
    'console_focus_param', seed.console_focus_param,
    'console_focus_source', seed.console_focus_source
  )
FROM public.lookup_definitions ld
CROSS JOIN task_type_seed seed
WHERE ld.category = 'task_type'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    sort_order = EXCLUDED.sort_order,
    status = EXCLUDED.status,
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

COMMIT;
