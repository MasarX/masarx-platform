-- 202605031730_w53_task_type_route_plan_metadata_repair_v1.sql
--
-- Repair two W53 backend mirror gaps found by current pgTAP verification:
-- 1) the task_type lookup category must exist because Console V2 review
--    queue chips and reviewer hints read lookup_values.metadata;
-- 2) the active route_plan_thresholds settings version must carry
--    wave_promise_window_seconds even when a later version supersedes the
--    original W53-updated row.

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
  'Canonical task type taxonomy with Console V2 tone and reviewer-description metadata.',
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

WITH task_type_seed(value, label, sort_order, tone, reviewer_description) AS (
  VALUES
    ('manual_review', 'Manual review', 10, 'neutral',
     'Manual review required. Workflow paused awaiting reviewer decision. Resume via transition_task_v1 with chosen next_status.'),
    ('dispatch_exception_review', 'Dispatch exception review', 20, 'warn',
     'Driver attempted delivery and recorded a non-final outcome. Review the resolution policy ladder result and apply the chosen action via apply_dispatch_exception_resolution_v1.'),
    ('tenant_signup_review', 'Tenant signup review', 30, 'info',
     'Inbound tenant signup request. Verify business name, billing details, and KYC docs before approval.'),
    ('shipment_amend_review', 'Shipment amend review', 40, 'warn',
     'Customer-requested shipment amendment. Validate the requested operation against amend policy and approve or reject.'),
    ('warehouse_supervisor_approval', 'Warehouse supervisor approval', 50, 'info',
     'Warehouse supervisor variance approval. Review variance summary and linked transfer before approve or reject.'),
    ('warehouse_scan_supervisor_approval', 'Warehouse scan supervisor approval', 60, 'info',
     'Out-of-sequence checkpoint scan correction. Review the scan trail and approve the override.'),
    ('route_stop_execute', 'Route stop execute', 70, 'info',
     'Driver-side route stop execution task. Reviewed in driver console, not the operator review queue.')
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
    'reviewer_description', seed.reviewer_description
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

UPDATE public.settings_versions
SET value = jsonb_set(COALESCE(value, '{}'::jsonb), '{wave_promise_window_seconds}', to_jsonb(7200), TRUE),
    updated_at = now()
WHERE category = 'route_plan_thresholds'
  AND scope_type = 'global'
  AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND effective_until IS NULL
  AND approved_at IS NOT NULL
  AND COALESCE(value->>'wave_promise_window_seconds', '') IS DISTINCT FROM '7200';

UPDATE public.settings s
SET cached_value = sv.value,
    settings_version_id = sv.id,
    last_updated = now()
FROM public.settings_versions sv
WHERE s.category = 'route_plan_thresholds'
  AND s.scope_type = 'global'
  AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.category = s.category
  AND sv.scope_type = s.scope_type
  AND sv.scope_hash = s.scope_hash
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL;
