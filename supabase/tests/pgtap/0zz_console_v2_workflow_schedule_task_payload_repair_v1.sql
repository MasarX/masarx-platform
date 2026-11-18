-- pgTAP: Console V2 workflow schedule task payload repair patches
-- task_enqueue_dynamic schedules from backend-owned row-driven defaults.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(20);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_template UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_billing_user UUID := gen_random_uuid();
  v_trigger UUID;
  v_other_trigger UUID;
  v_preflight JSONB;
  v_repair JSONB;
  v_run JSONB;
  v_run_id UUID;
  v_cross_scope_denied BOOLEAN := FALSE;
  v_no_capability_denied BOOLEAN := FALSE;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Schedule Payload Repair Org', 'schedule-payload-repair-' || left(v_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Schedule Payload Repair Client', 'schedule-payload-repair-client-' || left(v_client::text, 8), 'active');

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_other_org, 'Schedule Payload Other Org', 'schedule-payload-other-' || left(v_other_org::text, 8));

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_other_client, v_other_org, 'Schedule Payload Other Client', 'schedule-payload-other-client-' || left(v_other_client::text, 8), 'active');

  INSERT INTO public.workflow_templates (id, name, description, version, status, scope_type, scope_id, notes)
  VALUES (
    v_template,
    'schedule_payload_repair_' || left(v_template::text, 8),
    'Template used for schedule task payload repair pgTAP coverage.',
    1,
    'active',
    'tenant',
    v_org,
    'pgTAP fixture workflow template with dynamic task payload repair'
  );

  INSERT INTO public.workflow_template_steps (
    workflow_template_id,
    sequence_order,
    operation_name,
    transition_condition,
    metadata,
    handler_key,
    handler_version,
    enabled
  )
  VALUES (
    v_template,
    1,
    'binding_marketing_lead_review_task',
    'success',
    jsonb_build_object('task_path', '$.context.binding_payload.task', 'context_key', 'task'),
    'task_enqueue_dynamic',
    'v1',
    TRUE
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'schedule-payload-repair-' || left(v_user::text, 8) || '@example.com',
    'Schedule Payload Repair User',
    'client_admin',
    'client',
    v_client
  );

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_billing_user,
    v_org,
    'schedule-payload-billing-' || left(v_billing_user::text, 8) || '@example.com',
    'Schedule Payload Billing Viewer',
    'billing_viewer',
    'tenant',
    NULL
  );

  INSERT INTO public.workflow_schedule_triggers (
    scope_type,
    scope_id,
    workflow_template_id,
    schedule,
    context_patch,
    enabled,
    notes
  )
  VALUES (
    'client',
    v_other_client,
    v_template,
    jsonb_build_object('type', 'interval', 'interval_seconds', 3600),
    jsonb_build_object('source', 'pgtap_schedule_payload_repair_cross_scope'),
    TRUE,
    'cross-scope denial fixture'
  )
  RETURNING id INTO v_other_trigger;

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT (
    public.ui_create_workflow_schedule_trigger_v1(
      v_template,
      jsonb_build_object('type', 'interval', 'interval_seconds', 3600),
      jsonb_build_object('source', 'pgtap_schedule_payload_repair'),
      TRUE,
      NULL
    )->>'workflow_schedule_trigger_id'
  )::uuid
  INTO v_trigger;

  SELECT public.ui_run_workflow_schedule_trigger_v1(v_trigger)
  INTO v_preflight;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(v_preflight->>'status', 'preflight_failed', 'Run-now preflight fails before repair');
  PERFORM ok(
    (SELECT last_error FROM public.workflow_schedule_triggers WHERE id = v_trigger)
      LIKE '%$.context.binding_payload.task%',
    'Schedule stores missing task payload error before repair'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.ui_repair_workflow_schedule_task_payload_v1(
    v_trigger,
    jsonb_build_object(
      'context',
      jsonb_build_object(
        'organization_id', v_other_org,
        'scope_type', 'tenant',
        'scope_id', v_other_org,
        'workflow_template_id', v_other_org,
        'workflow_schedule_trigger_id', v_other_org
      ),
      'metadata',
      jsonb_build_object(
        'operation_name', 'spoofed_operation',
        'workflow_schedule_trigger_id', v_other_org
      )
    )
  )
  INTO v_repair;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(v_repair->>'status', 'payload_repaired', 'Repair returns payload_repaired status');
  PERFORM is(v_repair->>'operation_name', 'binding_marketing_lead_review_task', 'Repair reports the repaired task operation');
  PERFORM is(v_repair->>'task_type_key', 'marketing_lead_followup', 'Repair resolves task_type_key from operation defaults');
  PERFORM is(v_repair->>'resource_type', 'marketing_lead_request', 'Repair resolves resource_type from operation defaults');
  PERFORM ok((v_repair->'preflight'->>'ok')::boolean, 'Repair validates the patched context through preflight');
  PERFORM is(
    (SELECT context_patch #>> '{binding_payload,task,task_type_key}' FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    'marketing_lead_followup',
    'Schedule context_patch persists binding_payload.task.task_type_key'
  );
  PERFORM is(
    (SELECT context_patch #>> '{binding_payload,task,organization_id}' FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_org::text,
    'Schedule context_patch persists organization_id for task enqueue'
  );
  PERFORM is(
    (SELECT context_patch #>> '{binding_payload,task,context,organization_id}' FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_org::text,
    'Repair keeps backend-owned nested task context organization_id authoritative'
  );
  PERFORM is(
    (SELECT context_patch #>> '{binding_payload,task,context,scope_id}' FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_client::text,
    'Repair keeps backend-owned nested task context scope_id authoritative'
  );
  PERFORM is(
    (SELECT context_patch #>> '{binding_payload,task,metadata,operation_name}' FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    'binding_marketing_lead_review_task',
    'Repair keeps backend-owned task metadata operation_name authoritative'
  );
  PERFORM is(
    (SELECT last_error FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    NULL,
    'Repair clears prior schedule last_error'
  );
  PERFORM ok(
    pg_get_functiondef(to_regprocedure('public.ui_repair_workflow_schedule_task_payload_v1(uuid,jsonb)'))
      LIKE '%assert_capability_v1(''workflows.write''%',
    'Repair wrapper asserts canonical workflows.write'
  );
  PERFORM ok(
    has_function_privilege(
      'authenticated',
      'api.ui_repair_workflow_schedule_task_payload_v1(uuid,jsonb)',
      'EXECUTE'
    ),
    'API schema repair wrapper is executable by authenticated clients'
  );

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.ui_repair_workflow_schedule_task_payload_v1(v_other_trigger);
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_cross_scope_denied := TRUE;
  END;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM ok(v_cross_scope_denied, 'Repair denies schedules outside the caller scope');

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_billing_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_billing_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';
  BEGIN
    PERFORM public.ui_repair_workflow_schedule_task_payload_v1(v_trigger);
  EXCEPTION
    WHEN insufficient_privilege THEN
      v_no_capability_denied := TRUE;
  END;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM ok(v_no_capability_denied, 'Repair denies callers without workflows.write capability');

  EXECUTE 'RESET ROLE';
  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', v_user, 'role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.ui_run_workflow_schedule_trigger_v1(v_trigger)
  INTO v_run;
  v_run_id := (v_run->>'workflow_run_id')::uuid;

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(v_run->>'status', 'workflow_started', 'Run-now starts workflow after repair');
  PERFORM ok(v_run_id IS NOT NULL, 'Run-now returns workflow_run_id after repair');
  PERFORM is(
    (SELECT last_run_id::text FROM public.workflow_schedule_triggers WHERE id = v_trigger),
    v_run_id::text,
    'Run-now stores last_run_id after repaired preflight succeeds'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
