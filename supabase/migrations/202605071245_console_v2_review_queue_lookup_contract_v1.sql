-- Console V2 review queue lookup contract.
--
-- Live Console V2 hydrates task status/type/priority labels from the API
-- lookup functions before rendering the operator review queue. Keep these
-- rows backend-owned so first-tenant workflow tasks never appear as raw
-- `task_status/open (missing)` or `task_priority/40 (missing)` chips.

BEGIN;

SET search_path TO public, extensions, pg_temp;

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
  (
    'task_status',
    'Task lifecycle status taxonomy for Console V2 review, dispatch, and workflow task surfaces.',
    'operations',
    'tier_1',
    false
  ),
  (
    'task_priority',
    'Numeric task priority taxonomy used by task_types.default_priority and tasks.priority.',
    'operations',
    'tier_1',
    false
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  owner_role = EXCLUDED.owner_role,
  approval_policy = EXCLUDED.approval_policy,
  is_mutable = EXCLUDED.is_mutable,
  updated_at = now();

WITH lookup_rows AS (
  SELECT *
  FROM (
    VALUES
      ('task_status', 'open', 'Open', 'Task is open and waiting for work.', 10, true, '{"tone":"info","is_terminal":false,"is_snoozed":false}'::jsonb),
      ('task_status', 'assigned', 'Assigned', 'Task is assigned to an owner.', 20, false, '{"tone":"info","is_terminal":false,"is_snoozed":false}'::jsonb),
      ('task_status', 'in_progress', 'In progress', 'Task work has started.', 30, false, '{"tone":"info","is_terminal":false,"is_snoozed":false}'::jsonb),
      ('task_status', 'awaiting_input', 'Awaiting input', 'Task is blocked on external input.', 40, false, '{"tone":"warn","is_terminal":false,"is_snoozed":false}'::jsonb),
      ('task_status', 'snoozed', 'Snoozed', 'Task is deferred until its snooze window elapses.', 50, false, '{"tone":"neutral","is_terminal":false,"is_snoozed":true}'::jsonb),
      ('task_status', 'escalated', 'Escalated', 'Task has been escalated for supervisor attention.', 60, false, '{"tone":"danger","is_terminal":false,"is_snoozed":false}'::jsonb),
      ('task_status', 'completed', 'Completed', 'Task is complete.', 70, false, '{"tone":"good","is_terminal":true,"is_snoozed":false}'::jsonb),
      ('task_status', 'rejected', 'Rejected', 'Task was rejected.', 80, false, '{"tone":"danger","is_terminal":true,"is_snoozed":false}'::jsonb),
      ('task_status', 'cancelled', 'Cancelled', 'Task was cancelled.', 90, false, '{"tone":"neutral","is_terminal":true,"is_snoozed":false}'::jsonb),
      ('task_priority', '10', 'Critical', 'Immediate supervisor attention required.', 10, false, '{"tone":"danger","severity":"critical"}'::jsonb),
      ('task_priority', '20', 'High', 'High-priority operational review.', 20, false, '{"tone":"warn","severity":"high"}'::jsonb),
      ('task_priority', '30', 'Elevated', 'Elevated operational review priority.', 30, false, '{"tone":"warn","severity":"elevated"}'::jsonb),
      ('task_priority', '40', 'Standard review', 'Default first-line review priority.', 40, true, '{"tone":"neutral","severity":"standard","is_default":true}'::jsonb),
      ('task_priority', '45', 'Partner review', 'Partner or marketplace review priority.', 45, false, '{"tone":"info","severity":"partner"}'::jsonb),
      ('task_priority', '50', 'Normal', 'Normal task priority.', 50, false, '{"tone":"neutral","severity":"normal"}'::jsonb),
      ('task_priority', '60', 'Low', 'Low task priority.', 60, false, '{"tone":"neutral","severity":"low"}'::jsonb),
      ('task_priority', 'urgent', 'Urgent', 'Compatibility label for urgent seed-mode tasks.', 110, false, '{"tone":"danger","severity":"critical"}'::jsonb),
      ('task_priority', 'high', 'High', 'Compatibility label for high seed-mode tasks.', 120, false, '{"tone":"warn","severity":"high"}'::jsonb),
      ('task_priority', 'normal', 'Normal', 'Compatibility label for normal seed-mode tasks.', 130, false, '{"tone":"neutral","severity":"normal"}'::jsonb),
      ('task_priority', 'medium', 'Medium', 'Compatibility label for medium seed-mode tasks.', 140, false, '{"tone":"info","severity":"medium"}'::jsonb),
      ('task_priority', 'low', 'Low', 'Compatibility label for low seed-mode tasks.', 150, false, '{"tone":"neutral","severity":"low"}'::jsonb)
  ) AS v(category, value, label, description, sort_order, is_default, metadata)
)
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
  d.id,
  r.value,
  r.label,
  r.description,
  r.sort_order,
  r.is_default,
  'active',
  r.metadata
FROM public.lookup_definitions d
JOIN lookup_rows r
  ON r.category = d.category
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET
  label = EXCLUDED.label,
  description = EXCLUDED.description,
  sort_order = EXCLUDED.sort_order,
  is_default = EXCLUDED.is_default,
  status = 'active',
  effective_until = NULL,
  retired_at = NULL,
  metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
  updated_at = now();

COMMIT;
