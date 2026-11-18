-- pgTAP: public.bulk_transition_tasks_v1 contract (allowed/denied/ladder/RLS)
-- Uses a deliberately empty task_ids array to drive the schema-validation
-- branch on the allowed path so the test is independent of underlying
-- task lifecycle setup; the audit/RLS branches still exercise the contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b617';
  v_ops UUID := '00000000-0000-0000-0000-00000000b771';
  v_sender UUID := '00000000-0000-0000-0000-00000000b772';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 BulkT Org', 'b6-bulk-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-bulk-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 Bulk Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-bulk-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 Bulk Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_ops);

  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_ops, r.id, v_ops, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.b6_bulk_org', v_org::text, true);
  PERFORM set_config('test.b6_bulk_ops', v_ops::text, true);
  PERFORM set_config('test.b6_bulk_sender', v_sender::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (capability passes; payload validation throws empty-array error -> proves cap-gate succeeded first)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_bulk_ops'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bulk_transition_tasks_v1(jsonb_build_object(
       'to_status', 'completed',
       'task_ids', '[]'::jsonb
     )) $$,
  '23502',
  NULL,
  'ops_admin passes capability gate (subsequent validation reports empty array)'
);
RESET ROLE;

-- 2) Denied (capability fails BEFORE payload validation -> 42501)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_bulk_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.bulk_transition_tasks_v1(jsonb_build_object(
       'to_status', 'completed',
       'task_ids', '[]'::jsonb
     )) $$,
  '42501',
  NULL,
  'non-admin user denied bulk_transition_tasks_v1 (capability gate)'
);
RESET ROLE;

-- 3) Ladder/audit: function exists with the expected signature
SELECT has_function(
  'public', 'bulk_transition_tasks_v1', ARRAY['jsonb'],
  'bulk_transition_tasks_v1(jsonb) function exists'
);

SELECT has_function(
  'api', 'bulk_transition_tasks_v1', ARRAY['jsonb'],
  'api.bulk_transition_tasks_v1(jsonb) wrapper exists for Console V2 api-schema clients'
);

-- 4) RLS isolation: task_bulk_transition_runs ledger is service-only
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.task_bulk_transition_runs', 'select'),
  'authenticated has no SELECT on task_bulk_transition_runs (service-only)'
);

CREATE TEMP TABLE b6_bulk_payload_fixture (
  task_id UUID,
  task_event_id UUID,
  snooze_until TEXT,
  outcome_snooze_until TEXT
) ON COMMIT DROP;

DO $$
DECLARE
  v_org UUID := current_setting('test.b6_bulk_org')::uuid;
  v_ops UUID := current_setting('test.b6_bulk_ops')::uuid;
  v_task_type UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_snooze_until TEXT := '2026-05-24T21:00:00.000Z';
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type, v_org, 'pgtap_bulk_snooze', 'pgTAP bulk snooze', TRUE, 2, 'workflow_review');

  INSERT INTO public.tasks (
    id, organization_id, task_type_id, task_type_key, resource_type, resource_id, status, priority, queue_key, metadata
  )
  VALUES (
    v_task, v_org, v_task_type, 'pgtap_bulk_snooze', 'workflow_review_queue_test', gen_random_uuid(),
    'open', 2, 'workflow_review', jsonb_build_object('source', 'pgtap-bulk-payload-forwarding')
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.bulk_transition_tasks_v1(jsonb_build_object(
    'to_status', 'snoozed',
    'task_ids', jsonb_build_array(v_task::text),
    'payload', jsonb_build_object('snooze_until', v_snooze_until)
  ))
    INTO v_result;

  EXECUTE 'RESET ROLE';

  INSERT INTO b6_bulk_payload_fixture (task_id, task_event_id, snooze_until, outcome_snooze_until)
  VALUES (
    v_task,
    ((v_result->'outcomes'->0)->>'task_event_id')::uuid,
    v_snooze_until,
    ((v_result->'outcomes'->0->'task_event_payload')->>'snooze_until')
  );
END $$;

SELECT is(
  (
    SELECT te.payload->>'snooze_until'
      FROM public.task_events te
      JOIN b6_bulk_payload_fixture f ON f.task_event_id = te.id
  ),
  (SELECT snooze_until FROM b6_bulk_payload_fixture),
  'bulk_transition_tasks_v1 forwards caller payload to transition_task_v1 task_event readback'
);

SELECT is(
  (SELECT outcome_snooze_until FROM b6_bulk_payload_fixture),
  (SELECT snooze_until FROM b6_bulk_payload_fixture),
  'bulk_transition_tasks_v1 returns task_event payload readback in outcomes'
);

CREATE TEMP TABLE b6_bulk_api_wrapper_fixture (
  task_id UUID,
  task_event_id UUID,
  task_status TEXT,
  event_snooze_until TEXT,
  outcome_snooze_until TEXT
) ON COMMIT DROP;

DO $$
DECLARE
  v_org UUID := current_setting('test.b6_bulk_org')::uuid;
  v_ops UUID := current_setting('test.b6_bulk_ops')::uuid;
  v_task_type UUID := gen_random_uuid();
  v_task UUID := gen_random_uuid();
  v_snooze_until TEXT := '2026-05-24T22:00:00.000Z';
  v_result JSONB;
  v_task_event_id UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type, v_org, 'pgtap_bulk_api_snooze', 'pgTAP bulk api snooze', TRUE, 2, 'workflow_review');

  INSERT INTO public.tasks (
    id, organization_id, task_type_id, task_type_key, resource_type, resource_id, status, priority, queue_key, metadata
  )
  VALUES (
    v_task, v_org, v_task_type, 'pgtap_bulk_api_snooze', 'workflow_review_queue_test', gen_random_uuid(),
    'open', 2, 'workflow_review', jsonb_build_object('source', 'pgtap-bulk-api-wrapper')
  );

  EXECUTE 'RESET ROLE';

  PERFORM set_config('request.jwt.claim.sub', v_ops::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.bulk_transition_tasks_v1(jsonb_build_object(
    'to_status', 'snoozed',
    'task_ids', jsonb_build_array(v_task::text),
    'payload', jsonb_build_object('snooze_until', v_snooze_until)
  ))
    INTO v_result;

  EXECUTE 'RESET ROLE';

  v_task_event_id := ((v_result->'outcomes'->0)->>'task_event_id')::uuid;

  INSERT INTO b6_bulk_api_wrapper_fixture (
    task_id, task_event_id, task_status, event_snooze_until, outcome_snooze_until
  )
  SELECT
    v_task,
    v_task_event_id,
    t.status,
    te.payload->>'snooze_until',
    (v_result->'outcomes'->0->'task_event_payload')->>'snooze_until'
  FROM public.tasks t
  JOIN public.task_events te ON te.id = v_task_event_id
  WHERE t.id = v_task;
END $$;

SELECT is(
  (SELECT task_status FROM b6_bulk_api_wrapper_fixture),
  'snoozed',
  'api.bulk_transition_tasks_v1 updates task status through canonical public RPC'
);

SELECT is(
  (SELECT outcome_snooze_until FROM b6_bulk_api_wrapper_fixture),
  (SELECT event_snooze_until FROM b6_bulk_api_wrapper_fixture),
  'api.bulk_transition_tasks_v1 returns the task_event payload readback used by Console'
);

SELECT * FROM finish();
ROLLBACK;
