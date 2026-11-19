-- pgTAP: settlement workflow task lifecycle guard.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(14);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'settlement_batch_transition_action'
       AND lv.value = 'approve'
       AND lv.metadata->>'from_status' = 'locked'
       AND lv.metadata->>'to_status' = 'approved'
  ),
  'settlement transition lookup includes locked -> approved'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'settlement_batches_enforce_status_transition'
       AND NOT tgisinternal
  ),
  'settlement status transition trigger is installed'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_trigger
     WHERE tgname = 'tasks_prevent_stale_settlement_task_completion'
       AND NOT tgisinternal
  ),
  'stale settlement task completion trigger is installed'
);

CREATE FUNCTION pg_temp.test_settlement_task_lifecycle_guard() RETURNS SETOF text LANGUAGE plpgsql AS $$
DECLARE
  v_org uuid := gen_random_uuid();
  v_branch uuid := gen_random_uuid();
  v_user uuid := gen_random_uuid();
  v_task_type uuid := gen_random_uuid();
  v_manager_task_type uuid := gen_random_uuid();
  v_open_batch uuid := gen_random_uuid();
  v_approved_batch uuid := gen_random_uuid();
  v_task uuid := gen_random_uuid();
  v_manager_task uuid := gen_random_uuid();
  v_ops_session record;
  v_transition record;
  v_approve record;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Settlement Guard Org', 'settlement-guard-' || left(v_org::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'sg-' || left(v_branch::text, 8), 'Settlement Guard Branch');

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'settlement-guard-' || left(v_user::text, 8) || '@example.com',
    'Settlement Guard User',
    'ops_admin',
    'tenant'
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('source', 'pgtap', 'template_key', r.key)
    FROM public.rbac_roles r
   WHERE r.organization_id = v_org
     AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  INSERT INTO public.task_types (
    id,
    organization_id,
    key,
    name,
    enabled,
    default_priority,
    default_queue_key,
    metadata
  )
  VALUES (
    v_task_type,
    v_org,
    'cod_cashier_count',
    'COD Cashier Count',
    TRUE,
    50,
    'finance',
    jsonb_build_object('settlement_batch_action_statuses', jsonb_build_array('open'))
  );

  INSERT INTO public.task_types (
    id,
    organization_id,
    key,
    name,
    enabled,
    default_priority,
    default_queue_key,
    metadata
  )
  VALUES (
    v_manager_task_type,
    v_org,
    'cod_manager_approval',
    'COD Manager Approval',
    TRUE,
    50,
    'finance',
    jsonb_build_object('settlement_batch_action_statuses', jsonb_build_array('locked'))
  );

  INSERT INTO public.settlement_batches (
    id,
    organization_id,
    kind,
    scope_type,
    branch_id,
    subject_type,
    subject_id,
    status,
    version
  )
  VALUES
    (v_open_batch, v_org, 'cod', 'driver_shift', v_branch, 'driver', v_user, 'open', 1),
    (v_approved_batch, v_org, 'cod', 'driver_shift', v_branch, 'driver', v_user, 'approved', 1);

  INSERT INTO public.tasks (
    id,
    organization_id,
    task_type_id,
    task_type_key,
    resource_type,
    resource_id,
    status,
    queue_key,
    priority,
    metadata
  )
  VALUES (
    v_task,
    v_org,
    v_task_type,
    'cod_cashier_count',
    'settlement_batch',
    v_approved_batch,
    'open',
    'finance',
    50,
    jsonb_build_object('allowed_actions', jsonb_build_array('record_cashier_count'))
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_ops_session
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'branch_cash_drawer',
      'branch_id', v_branch,
      'idempotency_key', 'pgtap-settlement-guard-session'
    ))
   LIMIT 1;

  RETURN NEXT ok(v_ops_session.ops_session_id IS NOT NULL, 'ops session exists for stale task completion attempt');

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
          FROM public.transition_task_v1(
            %L::uuid,
            'completed',
            'should be blocked',
            jsonb_build_object('amount', 1, 'currency', 'SAR', 'ops_session_id', %L::uuid),
            'pgtap-stale-settlement-task'
          )
      $sql$,
      v_task,
      v_ops_session.ops_session_id
    ),
    '23514',
    NULL,
    'stale settlement task completion is blocked before task mutation'
  );

  RETURN NEXT is(
    (SELECT status FROM public.tasks WHERE id = v_task),
    'open',
    'blocked stale task remains open'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.task_events WHERE task_id = v_task AND event_type = 'status_changed'),
    0,
    'blocked stale task does not append a task event'
  );

  EXECUTE 'SET LOCAL ROLE service_role';

  RETURN NEXT throws_ok(
    format(
      $sql$
        UPDATE public.tasks
           SET status = 'rejected'
         WHERE id = %L::uuid
      $sql$,
      v_task
    ),
    '23514',
    NULL,
    'stale settlement task rejection is blocked before task mutation'
  );

  SELECT *
    INTO v_transition
    FROM public.transition_settlement_batch_v1(jsonb_build_object(
      'settlement_batch_id', v_open_batch,
      'to_status', 'locked',
      'idempotency_key', 'pgtap-settlement-guard-lock'
    ))
   LIMIT 1;

  RETURN NEXT ok(v_transition.settlement_event_id IS NOT NULL, 'open -> locked service transition remains allowed');

  INSERT INTO public.tasks (
    id,
    organization_id,
    task_type_id,
    task_type_key,
    resource_type,
    resource_id,
    status,
    queue_key,
    priority,
    metadata
  )
  VALUES (
    v_manager_task,
    v_org,
    v_manager_task_type,
    'cod_manager_approval',
    'settlement_batch',
    v_open_batch,
    'open',
    'finance',
    50,
    jsonb_build_object('allowed_actions', jsonb_build_array('approve', 'reject'))
  );

  SELECT *
    INTO v_approve
    FROM public.transition_settlement_batch_v1(jsonb_build_object(
      'settlement_batch_id', v_open_batch,
      'to_status', 'approved',
      'idempotency_key', 'pgtap-settlement-guard-approve'
    ))
   LIMIT 1;

  RETURN NEXT ok(v_approve.settlement_event_id IS NOT NULL, 'locked -> approved workflow transition is row-configured');

  RETURN NEXT is(
    (SELECT status FROM public.tasks WHERE id = v_manager_task),
    'cancelled',
    'future settlement approval auto-cancels stale manager task'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::int FROM public.task_events WHERE task_id = v_manager_task AND event_type = 'status_changed' AND to_status = 'cancelled'),
    1,
    'future stale manager task cancellation records task event'
  );

  RETURN NEXT throws_ok(
    format(
      $sql$
        SELECT *
          FROM public.transition_settlement_batch_v1(jsonb_build_object(
            'settlement_batch_id', %L::uuid,
            'to_status', 'locked',
            'idempotency_key', 'pgtap-settlement-guard-regress'
          ))
      $sql$,
      v_open_batch
    ),
    '23514',
    NULL,
    'approved -> locked settlement regression is blocked'
  );

  RETURN NEXT is(
    (SELECT status FROM public.settlement_batches WHERE id = v_open_batch),
    'approved',
    'blocked settlement regression preserves approved status'
  );
END;
$$;
SELECT * FROM pg_temp.test_settlement_task_lifecycle_guard();

SELECT * FROM finish();

ROLLBACK;
