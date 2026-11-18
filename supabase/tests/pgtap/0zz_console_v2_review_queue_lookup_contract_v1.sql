-- pgTAP: Console V2 review queue lookup rows are API-visible and match the
-- live task projection consumed by the browser queue.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists for Console V2 lookup hydration'
);

SELECT has_view('api', 'tasks', 'api.tasks projection exists for Console V2 task reads');

SELECT has_column('api', 'tasks', 'task_type_key', 'api.tasks exposes task_type_key for review queue labels');

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '7e875f8c-1992-4213-9d31-f980c0761c44'::uuid,
  'Console V2 Review Queue Lookup Org',
  'console-v2-review-queue-lookup-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'ae447fdf-a393-4c5d-9771-a8dd09dd7072'::uuid,
  '7e875f8c-1992-4213-9d31-f980c0761c44'::uuid,
  'console-v2-review-queue-lookups@example.test',
  'Console V2 Review Queue Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'ae447fdf-a393-4c5d-9771-a8dd09dd7072', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'ae447fdf-a393-4c5d-9771-a8dd09dd7072',
    'role', 'authenticated',
    'email', 'console-v2-review-queue-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT row.label
    FROM api.list_lookup_values_v1('task_status') AS row
    WHERE row.value = 'open'
  ),
  'Open',
  'task_status.open resolves to an operator-facing label'
);

SELECT is(
  (
    SELECT row.metadata->>'is_snoozed'
    FROM api.list_lookup_values_v1('task_status') AS row
    WHERE row.value = 'snoozed'
  ),
  'true',
  'task_status.snoozed carries snooze metadata for row-driven UI behavior'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM api.list_lookup_values_v1('task_status') AS row
    WHERE row.value IN ('open', 'assigned', 'in_progress', 'awaiting_input', 'snoozed', 'escalated', 'completed', 'rejected', 'cancelled')
  ),
  9,
  'all review queue task statuses are API-visible'
);

SELECT is(
  (
    SELECT row.label
    FROM api.list_lookup_values_v1('task_priority') AS row
    WHERE row.value = '40'
  ),
  'Standard review',
  'task_priority.40 resolves for tenant signup review tasks'
);

SELECT is(
  (
    SELECT row.metadata->>'tone'
    FROM api.list_lookup_values_v1('task_priority') AS row
    WHERE row.value = '45'
  ),
  'info',
  'task_priority.45 carries tone metadata for partner review tasks'
);

SELECT is(
  (
    SELECT count(*)::int
    FROM api.list_lookup_values_v1('task_priority') AS row
    WHERE row.value IN ('10', '20', '30', '40', '45', '50', '60', 'urgent', 'high', 'normal', 'medium', 'low')
  ),
  12,
  'numeric and compatibility task priorities are API-visible'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
