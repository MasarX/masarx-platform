-- Plan: PLAN-202601-tasks-ssot-core / Step: S95
-- pgTAP: Tasks SSOT core invariants (idempotency + projection)

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(26);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_assignee UUID := gen_random_uuid();
  v_task_type UUID := gen_random_uuid();
  v_ops_session RECORD;

  v_created RECORD;
  v_created_2 RECORD;
  v_assigned RECORD;
  v_assigned_2 RECORD;
  v_done RECORD;
  v_done_2 RECORD;
  v_sys_task RECORD;
  v_sys_task_2 RECORD;
  v_sys_followup_task RECORD;
  v_org_scoped_catalog UUID := gen_random_uuid();
  v_sys_followup_task_scoped RECORD;
  v_stale_catalog_value JSONB := jsonb_build_object(
    'version', 1,
    'task_types', jsonb_build_array(
      jsonb_build_object(
        'key', 'dispatch_exception_review',
        'name', 'Dispatch Exception Review',
        'enabled', TRUE,
        'default_priority', 50,
        'default_queue_key', 'default'
      )
    )
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Tasks SSOT Org', 'tasks-ssot-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, access_scope_type)
  VALUES
    (v_user, v_org, 'tasks-ssot-' || left(v_user::text, 8) || '@example.com', 'Tasks SSOT User', 'tenant'),
    (v_assignee, v_org, 'tasks-ssot-' || left(v_assignee::text, 8) || '@example.com', 'Tasks SSOT Assignee', 'tenant');

  INSERT INTO task_types (id, organization_id, key, name, enabled, default_priority, default_queue_key)
  VALUES (v_task_type, v_org, 'delivery', 'Delivery', true, 50, 'default');

  -- RBAC: task mutation RPCs are permission-gated; grant ops_admin to the actor user.
  PERFORM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin'], v_user);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org, v_user, r.id, v_user, jsonb_build_object('seed', TRUE, 'source', 'pgtap', 'template_key', r.key)
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org
    AND r.key = 'ops_admin'
  ON CONFLICT DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT *
    INTO v_created
    FROM public.create_task_v1(
      p_task_type_key := 'delivery',
      p_context := jsonb_build_object('organization_id', v_org),
      p_resource_type := 'shipment',
      p_resource_id := gen_random_uuid(),
      p_idempotency_key := 'pgtap-create-1'
    )
   LIMIT 1;

  SELECT *
    INTO v_created_2
    FROM public.create_task_v1(
      p_task_type_key := 'delivery',
      p_context := jsonb_build_object('organization_id', v_org),
      p_resource_type := 'shipment',
      p_resource_id := gen_random_uuid(),
      p_idempotency_key := 'pgtap-create-1'
    )
   LIMIT 1;

  PERFORM is(v_created.task_id::text, v_created_2.task_id::text, 'create_task_v1 idempotency returns same task_id');
  PERFORM is(v_created.task_event_id::text, v_created_2.task_event_id::text, 'create_task_v1 idempotency returns same task_event_id');
  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.tasks WHERE organization_id = v_org AND idempotency_key = 'pgtap-create-1'),
    1,
    'create_task_v1 does not duplicate tasks for same idempotency_key'
  );

  SELECT *
    INTO v_assigned
    FROM public.assign_task_v1(
      p_task_id := v_created.task_id,
      p_assigned_to := v_assignee,
      p_idempotency_key := 'pgtap-assign-1',
      p_notes := 'assign'
    )
   LIMIT 1;

  SELECT *
    INTO v_assigned_2
    FROM public.assign_task_v1(
      p_task_id := v_created.task_id,
      p_assigned_to := v_assignee,
      p_idempotency_key := 'pgtap-assign-1',
      p_notes := 'assign'
    )
   LIMIT 1;

  PERFORM is(v_assigned.task_event_id::text, v_assigned_2.task_event_id::text, 'assign_task_v1 idempotency returns same task_event_id');
  PERFORM is((SELECT version FROM public.tasks WHERE id = v_created.task_id)::INT, 2, 'assign_task_v1 idempotency increments version once');

  SELECT *
    INTO v_ops_session
    FROM public.open_ops_session_v1(jsonb_build_object(
      'session_type', 'driver_shift',
      'idempotency_key', 'pgtap-ops-session-1'
    ))
   LIMIT 1;

  PERFORM ok(v_ops_session.ops_session_id IS NOT NULL, 'open_ops_session_v1 creates an ops session (driver_shift)');

  SELECT *
    INTO v_done
    FROM public.transition_task_v1(
      p_task_id := v_created.task_id,
      p_to_status := 'completed',
      p_status_reason := 'done',
      p_payload := jsonb_build_object('source', 'pgtap', 'ops_session_id', v_ops_session.ops_session_id),
      p_idempotency_key := 'pgtap-done-1'
    )
   LIMIT 1;

  SELECT *
    INTO v_done_2
    FROM public.transition_task_v1(
      p_task_id := v_created.task_id,
      p_to_status := 'completed',
      p_status_reason := 'done',
      p_payload := jsonb_build_object('source', 'pgtap', 'ops_session_id', v_ops_session.ops_session_id),
      p_idempotency_key := 'pgtap-done-1'
    )
   LIMIT 1;

  PERFORM is(v_done.task_event_id::text, v_done_2.task_event_id::text, 'transition_task_v1 idempotency returns same task_event_id');
  PERFORM is((SELECT status FROM public.tasks WHERE id = v_created.task_id), 'completed', 'transition_task_v1 updates projection status');

  PERFORM is(
    (SELECT ops_session_id::text FROM public.task_events WHERE id = v_done.task_event_id),
    v_ops_session.ops_session_id::text,
    'transition_task_v1 stores ops_session_id on task_events'
  );

  PERFORM is(
    (SELECT status FROM public.tasks WHERE id = v_created.task_id),
    (SELECT to_status FROM public.task_events WHERE task_id = v_created.task_id ORDER BY task_version DESC LIMIT 1),
    'projection status matches latest event to_status'
  );

  PERFORM is(
    (SELECT version FROM public.tasks WHERE id = v_created.task_id)::INT,
    (SELECT MAX(task_version)::INT FROM public.task_events WHERE task_id = v_created.task_id),
    'tasks.version matches max(task_events.task_version)'
  );

  PERFORM is((SELECT COUNT(*)::INT FROM public.task_events WHERE task_id = v_created.task_id), 3, 'task_events has expected count');

  PERFORM ok(
    (SELECT COUNT(*)::INT FROM public.task_events WHERE task_id = v_created.task_id AND decision_log_id IS NOT NULL) = 3,
    'task_events rows link to decision_log_id'
  );

  PERFORM ok(
    (SELECT settings_resolution_id IS NOT NULL FROM public.task_events WHERE id = v_created.task_event_id),
    'create event records settings_resolution_id'
  );

  -- Service-only create path should auto-provision task_types from task_type_catalog (insert-only).
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_sys_task
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org),
        'resource_type', 'route_stop',
        'resource_id', gen_random_uuid(),
        'idempotency_key', 'pgtap-system-create-1',
        'actor_system', 'pgtap'
      )
    )
   LIMIT 1;

  PERFORM ok(v_sys_task.task_id IS NOT NULL, 'create_task_system_v1 creates a task for service role');
  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.task_types WHERE organization_id = v_org AND key = 'route_stop_execute'),
    1,
    'create_task_system_v1 auto-provisions task_type from task_type_catalog when missing'
  );
  PERFORM is(
    (SELECT tt.key FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id WHERE t.id = v_sys_task.task_id),
    'route_stop_execute',
    'created task uses the auto-provisioned task_type'
  );

  SELECT *
    INTO v_sys_followup_task
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'dispatch_exception_review',
        'context', jsonb_build_object('organization_id', v_org),
        'resource_type', 'shipment',
        'resource_id', gen_random_uuid(),
        'idempotency_key', 'pgtap-system-create-2',
        'actor_system', 'pgtap'
      )
    )
   LIMIT 1;

  PERFORM ok(v_sys_followup_task.task_id IS NOT NULL, 'create_task_system_v1 creates a dispatch follow-up task');
  PERFORM is(
    (SELECT COALESCE(t.metadata->'assignment_defaults'->>'queue_key', '')
       FROM public.tasks t
      WHERE t.id = v_sys_followup_task.task_id),
    'dispatch',
    'create_task_system_v1 persists inherited assignment_defaults.queue_key on task metadata'
  );
  PERFORM is(
    (SELECT NULLIF(t.metadata->'assignment_defaults'->>'sla_minutes', '')::int
       FROM public.tasks t
      WHERE t.id = v_sys_followup_task.task_id),
    60,
    'create_task_system_v1 persists inherited assignment_defaults.sla_minutes on task metadata'
  );

  SELECT *
    INTO v_sys_task_2
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'route_stop_execute',
        'context', jsonb_build_object('organization_id', v_org),
        'resource_type', 'route_stop',
        'resource_id', gen_random_uuid(),
        'idempotency_key', 'pgtap-system-create-1',
        'actor_system', 'pgtap'
      )
    )
   LIMIT 1;

  PERFORM is(v_sys_task.task_id::text, v_sys_task_2.task_id::text, 'create_task_system_v1 idempotency returns same task_id');
  PERFORM is(
    (SELECT COUNT(*)::INT FROM public.task_types WHERE organization_id = v_org AND key = 'route_stop_execute'),
    1,
    'auto-provisioning is idempotent (task_types not duplicated)'
  );

  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (
    v_org_scoped_catalog,
    'Tasks SSOT Scoped Catalog Org',
    'tasks-ssot-scoped-' || left(v_org_scoped_catalog::text, 8)
  );

  UPDATE public.settings
     SET cached_value = v_stale_catalog_value,
         last_updated = workflow_now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'tenant'
     AND scope_id = v_org_scoped_catalog;

  UPDATE public.settings_versions
     SET value = v_stale_catalog_value
   WHERE id = (
     SELECT s.settings_version_id
       FROM public.settings s
      WHERE s.category = 'task_type_catalog'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org_scoped_catalog
      LIMIT 1
   );

  INSERT INTO public.task_types (
    organization_id,
    key,
    name,
    enabled,
    default_priority,
    default_queue_key,
    metadata
  )
  VALUES (
    v_org_scoped_catalog,
    'dispatch_exception_review',
    'Dispatch Exception Review',
    TRUE,
    50,
    'default',
    '{}'::jsonb
  );

  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'service_role')::text, true);
  EXECUTE 'SET LOCAL ROLE service_role';

  SELECT *
    INTO v_sys_followup_task_scoped
    FROM public.create_task_system_v1(
      jsonb_build_object(
        'task_type_key', 'dispatch_exception_review',
        'context', jsonb_build_object('organization_id', v_org_scoped_catalog),
        'resource_type', 'shipment',
        'resource_id', gen_random_uuid(),
        'idempotency_key', 'pgtap-system-create-scoped-drift',
        'actor_system', 'pgtap'
      )
    )
   LIMIT 1;

  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(
    v_sys_followup_task_scoped.task_id IS NOT NULL,
    'create_task_system_v1 creates a task when tenant-scoped task_type_catalog defaults are stale'
  );
  PERFORM is(
    (SELECT default_queue_key
       FROM public.task_types
      WHERE organization_id = v_org_scoped_catalog
        AND key = 'dispatch_exception_review'),
    'dispatch',
    'create_task_system_v1 repairs stale task_type default_queue_key from broader catalog defaults'
  );
  PERFORM is(
    (SELECT COALESCE(metadata->'assignment_defaults'->>'queue_key', '')
       FROM public.task_types
      WHERE organization_id = v_org_scoped_catalog
        AND key = 'dispatch_exception_review'),
    'dispatch',
    'create_task_system_v1 repairs stale task_type assignment_defaults.queue_key from broader catalog defaults'
  );
  PERFORM is(
    (SELECT queue_key
       FROM public.tasks
      WHERE id = v_sys_followup_task_scoped.task_id),
    'dispatch',
    'create_task_system_v1 uses repaired queue defaults after scoped catalog drift'
  );
END $$;

SELECT * FROM finish();

ROLLBACK;
