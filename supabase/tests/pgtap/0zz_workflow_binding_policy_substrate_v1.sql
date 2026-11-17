-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- pgTAP: Workflow binding policy substrate

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(27);

SELECT ok(to_regclass('public.workflow_binding_registry') IS NOT NULL, 'workflow_binding_registry table exists');
SELECT ok(to_regclass('public.workflow_binding_stage_registry') IS NOT NULL, 'workflow_binding_stage_registry table exists');
SELECT ok(to_regclass('public.workflow_binding_dispatches') IS NOT NULL, 'workflow_binding_dispatches table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'workflow_binding_dispatches'), 'RLS enabled on workflow_binding_dispatches');
SELECT ok(EXISTS(SELECT 1 FROM public.settings_category_registry WHERE category = 'workflow_binding_policy'), 'workflow_binding_policy settings category exists');
SELECT ok(to_regprocedure('public.resolve_workflow_binding_v1(text,text,jsonb)') IS NOT NULL, 'resolve_workflow_binding_v1 exists');
SELECT ok(to_regprocedure('public.run_workflow_binding_stage_v1(jsonb)') IS NOT NULL, 'run_workflow_binding_stage_v1 exists');
SELECT ok(to_regprocedure('public.workflow_binding_policy_baseline_v1()') IS NOT NULL, 'workflow_binding_policy_baseline_v1 exists');
SELECT ok(to_regprocedure('public.workflow_binding_request_entry_point_v1(text,uuid,text)') IS NOT NULL, 'workflow_binding_request_entry_point_v1 exists');
SELECT ok(to_regprocedure('api.ui_list_workflow_bindings_v1(text,uuid)') IS NOT NULL, 'api.ui_list_workflow_bindings_v1 exists');
SELECT ok(to_regprocedure('api.ui_workflow_binding_clone_override_v1(text,text,text,uuid)') IS NOT NULL, 'api.ui_workflow_binding_clone_override_v1 exists');
SELECT ok(to_regprocedure('api.ui_workflow_binding_reset_override_v1(text,text,text,uuid)') IS NOT NULL, 'api.ui_workflow_binding_reset_override_v1 exists');
SELECT ok(to_regclass('api.workflow_business_action_inventory_v1') IS NOT NULL, 'api.workflow_business_action_inventory_v1 exists');
SELECT ok(EXISTS(
  SELECT 1
  FROM public.lookup_values lv
  JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
  WHERE ld.category = 'decision_category'
    AND lv.value = 'workflow_binding'
), 'decision_category includes workflow_binding');
SELECT ok(
  public.resolve_settings('workflow_binding_policy', public.get_root_scope_type_key_v1(), NULL)
    #>> ARRAY['bindings','customer_shipment_change','stages','request_received','workflow_template_id'] IS NOT NULL,
  'global workflow binding policy resolves seeded customer shipment change template'
);
SELECT is(
  (SELECT COUNT(*)::INT FROM public.settings WHERE category = 'workflow_binding_policy' AND scope_type = 'client'),
  0,
  'client scopes do not materialize workflow_binding_policy defaults by default'
);
SELECT is(
  (SELECT COUNT(*)::INT FROM public.settings WHERE category = 'workflow_binding_policy' AND scope_type = 'sender'),
  0,
  'sender scopes do not materialize workflow_binding_policy defaults by default'
);

CREATE OR REPLACE FUNCTION pg_temp.run_workflow_binding_substrate_checks()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $$
DECLARE
  v_org UUID := '3b100000-0000-0000-0000-000000000001'::uuid;
  v_client UUID := '3b100000-0000-0000-0000-000000000201'::uuid;
  v_sender UUID := '3b100000-0000-0000-0000-000000000301'::uuid;
  v_recipient UUID := '3b100000-0000-0000-0000-000000000401'::uuid;
  v_notify_result JSONB;
  v_task_result JSONB;
  v_notify_run UUID;
  v_notify_dispatch UUID;
  v_task_dispatch UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Workflow Binding Org', 'workflow-binding-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Workflow Binding Client', 'workflow-binding-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Workflow Binding Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number, email)
  VALUES (
    v_recipient,
    v_org,
    v_client,
    'Workflow Binding Recipient',
    '+966500002222',
    'workflow.binding+substrate@example.com'
  )
  ON CONFLICT (id) DO UPDATE
    SET name = EXCLUDED.name,
        phone_number = EXCLUDED.phone_number,
        email = EXCLUDED.email;

  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = 'workflow_binding_policy'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org
        AND jsonb_typeof(s.cached_value #> '{bindings,customer_shipment_change,stages}') = 'object'
    ),
    'tenant onboarding clones workflow binding stages for new organizations'
  );

  RETURN NEXT ok(
    (
      SELECT s.cached_value #>> '{bindings,customer_shipment_change,stages,request_received,workflow_template_id}'
      FROM public.settings s
      WHERE s.category = 'workflow_binding_policy'
        AND s.scope_type = 'tenant'
        AND s.scope_id = v_org
      LIMIT 1
    ) IS DISTINCT FROM (
      public.resolve_settings('workflow_binding_policy', public.get_root_scope_type_key_v1(), NULL)
        #>> ARRAY['bindings','customer_shipment_change','stages','request_received','workflow_template_id']
    ),
    'tenant onboarding clones a tenant-scoped template instead of reusing the global template id'
  );

  SELECT public.run_workflow_binding_stage_v1(
    jsonb_build_object(
      'binding_key', 'customer_shipment_change',
      'stage_key', 'request_received',
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'actor_system', 'public_tracking',
      'source_function', 'pgtap_workflow_binding_substrate',
      'idempotency_key', 'pgtap-workflow-binding-notify',
      'context', jsonb_build_object(
        'resource_type', 'support_case',
        'resource_id', '3b100000-0000-0000-0000-000000000501'::uuid,
        'binding_payload', jsonb_build_object(
          'notification', jsonb_build_object(
            'recipient_id', v_recipient,
            'organization_id', v_org,
            'stage', 'received',
            'message', 'Workflow binding substrate pgTAP notification',
            'channel', 'best_available'
          )
        )
      )
    )
  )
  INTO v_notify_result;

  BEGIN v_notify_dispatch := NULLIF(v_notify_result->>'dispatch_id', '')::UUID; EXCEPTION WHEN others THEN v_notify_dispatch := NULL; END;
  BEGIN v_notify_run := NULLIF(v_notify_result->>'workflow_run_id', '')::UUID; EXCEPTION WHEN others THEN v_notify_run := NULL; END;

  RETURN NEXT is(v_notify_result->>'outcome', 'completed', 'request_received binding dispatch completes inline');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.outbound_calls oc
    WHERE oc.context->>'source' = 'public_tracking'
      AND oc.target_id = v_recipient
      AND oc.body->>'stage' = 'received'
  ), 'dynamic notification handler preserves originating subsystem in outbound context');
  RETURN NEXT is(
    (SELECT entry_point FROM public.workflow_runs WHERE id = v_notify_run),
    'api',
    'binding workflow runs normalize to a valid request_entry_point'
  );
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.workflow_binding_dispatches d
    WHERE d.id = v_notify_dispatch
      AND d.settings_version_id IS NOT NULL
      AND d.step_operation_result->>'queued' = 'true'
  ), 'dispatch ledger stores step result and settings provenance for notification runs');

  SELECT public.run_workflow_binding_stage_v1(
    jsonb_build_object(
      'binding_key', 'customer_shipment_change',
      'stage_key', 'review_requested',
      'organization_id', v_org,
      'client_id', v_client,
      'sender_id', v_sender,
      'actor_system', 'public_tracking',
      'source_function', 'pgtap_workflow_binding_substrate',
      'idempotency_key', 'pgtap-workflow-binding-task',
      'context', jsonb_build_object(
        'resource_type', 'support_case',
        'resource_id', '3b100000-0000-0000-0000-000000000502'::uuid,
        'binding_payload', jsonb_build_object(
          'task', jsonb_build_object(
            'organization_id', v_org,
            'task_type_key', 'customer_shipment_change_review',
            'resource_type', 'support_case',
            'resource_id', '3b100000-0000-0000-0000-000000000502'::uuid,
            'idempotency_key', 'pgtap-workflow-binding-task',
            'metadata', jsonb_build_object('source', 'pgtap')
          )
        )
      )
    )
  )
  INTO v_task_result;

  BEGIN v_task_dispatch := NULLIF(v_task_result->>'dispatch_id', '')::UUID; EXCEPTION WHEN others THEN v_task_dispatch := NULL; END;

  RETURN NEXT is(v_task_result->>'outcome', 'completed', 'review_requested binding dispatch completes inline');
  RETURN NEXT ok(
    COALESCE(v_task_result #>> '{step_operation_result,task_id}', '') <> '',
    'review_requested binding returns a created task id'
  );
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.tasks t
    WHERE t.id = (v_task_result #>> '{step_operation_result,task_id}')::uuid
      AND t.resource_type = 'support_case'
  ), 'review_requested binding creates a task through the canonical task wrapper');
  RETURN NEXT ok(EXISTS(
    SELECT 1
    FROM public.workflow_binding_dispatches d
    WHERE d.id = v_task_dispatch
      AND d.step_operation_result->>'task_id' = (v_task_result #>> '{step_operation_result,task_id}')
  ), 'dispatch ledger stores created task id for task workflow runs');
END;
$$;

SELECT * FROM pg_temp.run_workflow_binding_substrate_checks();
SELECT finish();
ROLLBACK;
