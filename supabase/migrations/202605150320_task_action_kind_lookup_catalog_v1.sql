-- Console V2 task action registry.
-- Keeps task completion actions row-driven for review queue, dispatch stop closeout,
-- warehouse approvals, and amend/cancel surfaces.

BEGIN;

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable,
  scope_type
)
VALUES (
  'task_action_kind',
  'Task action kind registry consumed by Console V2 task transition surfaces.',
  'operations',
  'tier_1',
  false,
  'global'
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  scope_type = EXCLUDED.scope_type,
  updated_at = now();

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'task_action_kind'
),
rows(value, label, icon, tone, next_status, sort_order, is_default, extra_metadata) AS (
  VALUES
    ('_default', '-', 'right', 'neutral', 'in_progress', 10, true, '{}'::jsonb),
    ('retry', 'Retry delivery', 'right', 'info', 'in_progress', 20, false, '{}'::jsonb),
    ('reschedule', 'Reschedule', 'right', 'info', 'in_progress', 30, false, '{}'::jsonb),
    ('reassign', 'Reassign driver', 'shuffle', 'info', 'in_progress', 40, false, '{}'::jsonb),
    ('return_to_branch', 'Return to branch', 'package', 'warn', 'in_progress', 50, false, '{}'::jsonb),
    ('rtb', 'Return to branch', 'package', 'warn', 'in_progress', 60, false, '{}'::jsonb),
    ('cancel', 'Cancel', 'warn', 'danger', 'rejected', 70, false, '{}'::jsonb),
    ('resolve', 'Close as resolved', 'check', 'good', 'completed', 80, false, '{"bulk_strategy":"status_transition"}'::jsonb),
    ('approve', 'Approve', 'check', 'good', 'completed', 90, false, '{}'::jsonb),
    ('reject', 'Reject', 'warn', 'danger', 'rejected', 100, false, '{}'::jsonb),
    ('decline', 'Decline', 'warn', 'danger', 'rejected', 110, false, '{}'::jsonb),
    ('request_info', 'Request more info', 'edit', 'info', 'in_progress', 120, false, '{}'::jsonb),
    ('claim', 'Claim', 'check', 'good', 'in_progress', 130, false, '{"bulk_strategy":"assignment"}'::jsonb),
    ('escalate', 'Escalate', 'warn', 'warn', 'escalated', 140, false, '{"bulk_strategy":"status_transition"}'::jsonb),
    ('snooze', 'Snooze', 'lock', 'neutral', 'snoozed', 150, false, '{"is_snooze_action":true}'::jsonb)
),
upserted AS (
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
    definition.id,
    rows.value,
    rows.label,
    'Console V2 task action: ' || rows.label,
    rows.sort_order,
    rows.is_default,
    'active',
    rows.extra_metadata || jsonb_build_object(
      'icon', rows.icon,
      'tone', rows.tone,
      'next_status', rows.next_status
    )
  FROM definition
  CROSS JOIN rows
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
  SET
    label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    is_default = EXCLUDED.is_default,
    status = 'active',
    metadata = EXCLUDED.metadata,
    updated_at = now()
  RETURNING 1
)
SELECT count(*) FROM upserted;

COMMIT;
