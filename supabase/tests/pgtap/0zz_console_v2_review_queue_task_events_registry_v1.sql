-- pgTAP: Console V2 Review Queue task_events activity readback.
-- Ensures task activity is available through the canonical ui_read_registry
-- path used by Review Queue drawers after backend-backed task mutations.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

CREATE TEMP TABLE review_queue_task_event_fixture (
  org_id UUID,
  other_org_id UUID,
  operator_id UUID,
  denied_user_id UUID,
  task_id UUID,
  other_task_id UUID
) ON COMMIT DROP;
GRANT SELECT ON review_queue_task_event_fixture TO authenticated;

SELECT has_table('public', 'task_events', 'task_events ledger table exists');

SELECT ok(
  has_table_privilege('authenticated', 'public.task_events', 'SELECT'),
  'authenticated can SELECT task_events through RLS-backed reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'task_events'
       AND c.relrowsecurity IS TRUE
  ),
  'task_events remains RLS-backed for ui_read_registry reads'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
     WHERE value->>'key' = 'task_events'
       AND value->>'relation' = 'public.task_events'
       AND value->>'capability_read' = 'tasks.read'
       AND value#>>'{scope_columns,tenant}' = 'organization_id'
  ),
  'ui_read_registry exposes task_events through the RLS-backed task ledger'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.value->'filters', '[]'::jsonb)) AS f(value)
     WHERE r.value->>'key' = 'task_events'
       AND f.value->>'key' = 'task_id'
       AND f.value->>'column' = 'task_id'
       AND f.value->>'op' = 'eq'
  ),
  'task_events registry supports task_id drawer filtering'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(r.value->'filters', '[]'::jsonb)) AS f(value)
     WHERE r.value->>'key' = 'task_events'
       AND f.value->>'key' = 'ops_session_id'
       AND f.value->>'column' = 'ops_session_id'
       AND f.value->>'op' = 'eq'
  ),
  'task_events registry supports ops_session_id activity correlation filtering'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'global', NULL)->'resources') AS r(value)
     WHERE r.value->>'key' = 'task_events'
       AND r.value#>>'{default_sort,column}' = 'created_at'
       AND r.value#>>'{default_sort,direction}' = 'desc'
  ),
  'task_events registry sorts newest activity first by default'
);

DO $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_operator UUID := gen_random_uuid();
  v_denied_user UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_other_task UUID := gen_random_uuid();
  v_task_type UUID;
  v_other_task_type UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Review Queue Task Events Org', 'rq-task-events-' || left(v_org::text, 8)),
    (v_other_org, 'Review Queue Task Events Other Org', 'rq-task-events-other-' || left(v_other_org::text, 8));

  v_task_type := public.ensure_task_type_from_catalog_v1(
    v_org,
    'dispatch_exception_review',
    jsonb_build_object('organization_id', v_org)
  );
  v_other_task_type := public.ensure_task_type_from_catalog_v1(
    v_other_org,
    'dispatch_exception_review',
    jsonb_build_object('organization_id', v_other_org)
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_operator, v_org, 'rq-task-events-operator-' || left(v_operator::text, 8) || '@example.com', 'RQ Task Events Operator', 'ops_admin', 'tenant'),
    (v_denied_user, v_org, 'rq-task-events-denied-' || left(v_denied_user::text, 8) || '@example.com', 'RQ Task Events Denied', 'account_manager', 'tenant');

  INSERT INTO public.tasks (id, organization_id, task_type_id, task_type_key, resource_type, resource_id, status, priority, metadata)
  VALUES
    (v_task, v_org, v_task_type, 'dispatch_exception_review', 'shipment', gen_random_uuid(), 'completed', 1, jsonb_build_object('source', 'pgtap-review-queue-task-events')),
    (v_other_task, v_other_org, v_other_task_type, 'dispatch_exception_review', 'shipment', gen_random_uuid(), 'completed', 1, jsonb_build_object('source', 'pgtap-review-queue-task-events-other-org'));

  INSERT INTO public.task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    payload,
    task_version
  )
  VALUES
    (
      v_task,
      v_org,
      'status_changed',
      'open',
      'completed',
      v_operator,
      jsonb_build_object('amount', 64.5, 'currency', 'SAR', 'receipt_context', 'pgtap-review-queue-task-events'),
      1
    ),
    (
      v_other_task,
      v_other_org,
      'status_changed',
      'open',
      'completed',
      NULL,
      jsonb_build_object('amount', 64.5, 'currency', 'SAR', 'receipt_context', 'other-org-hidden'),
      1
    );

  INSERT INTO review_queue_task_event_fixture (org_id, other_org_id, operator_id, denied_user_id, task_id, other_task_id)
  VALUES (v_org, v_other_org, v_operator, v_denied_user, v_task, v_other_task);
END;
$fixture$;

SELECT set_config('request.jwt.claim.sub', (SELECT operator_id::text FROM review_queue_task_event_fixture), true);
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

SELECT is(
  public.ui_list_resource_v1(
    'task_events',
    jsonb_build_object('task_id', (SELECT task_id::text FROM review_queue_task_event_fixture)),
    20,
    0
  )->>'resource',
  'task_events',
  'ui_list_resource_v1 returns task_events for a tasks.read operator'
);

SELECT is(
  (
    public.ui_list_resource_v1(
      'task_events',
      jsonb_build_object('task_id', (SELECT task_id::text FROM review_queue_task_event_fixture)),
      20,
      0
    )->>'total'
  )::int,
  1,
  'task_events drawer filtering returns the matching same-tenant task event'
);

SELECT is(
  (
    public.ui_list_resource_v1(
      'task_events',
      jsonb_build_object('task_id', (SELECT other_task_id::text FROM review_queue_task_event_fixture)),
      20,
      0
    )->>'total'
  )::int,
  0,
  'task_events read remains tenant-scoped and hides another tenant task event'
);

RESET ROLE;
SELECT set_config('request.jwt.claim.sub', (SELECT denied_user_id::text FROM review_queue_task_event_fixture), true);
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

SELECT throws_like(
  $$
    SELECT public.ui_list_resource_v1('task_events', '{}'::jsonb, 20, 0)
  $$,
  '%tasks.read%',
  'task_events read denies users without tasks.read'
);

RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
