-- Test Suite: settings governance approval lifecycle
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_other_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_other_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_other_sender UUID := gen_random_uuid();
  v_initial_sv UUID := gen_random_uuid();
  v_pending_sv UUID;
  v_rejected_sv UUID;
  v_non_pending_sv UUID := gen_random_uuid();
  v_event UUID;
  v_duplicate_event UUID := gen_random_uuid();
  v_non_pending_event UUID := gen_random_uuid();
  v_task UUID;
  v_operator_task UUID;
  v_rejected_task UUID;
  v_rejected_operator_task UUID;
  v_workflow_run UUID;
  v_role_id UUID;
  v_label TEXT := 'settings approval queued';
  v_rejected_label TEXT := 'settings approval rejected';
  v_mismatch_rejected BOOLEAN := FALSE;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Settings Governance Org', 'settings-gov-' || left(v_org::text, 8)),
    (v_other_org, 'Settings Governance Other Org', 'settings-gov-other-' || left(v_other_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES
    (v_client, v_org, 'Settings Governance Client', 'settings-gov-client-' || left(v_client::text, 8), 'active'),
    (v_other_client, v_other_org, 'Settings Governance Other Client', 'settings-gov-other-client-' || left(v_other_client::text, 8), 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES
    (v_sender, v_client, 'Settings Governance Sender', 'Settings Governance Sender', TRUE, 'active'),
    (v_other_sender, v_other_client, 'Settings Governance Other Sender', 'Settings Governance Other Sender', TRUE, 'active');

  PERFORM public.bootstrap_tenant_onboarding_v1(v_org, 'pgtap:settings-governance-approval-lifecycle-fixture-bootstrap');
  PERFORM public.bootstrap_tenant_onboarding_v1(v_other_org, 'pgtap:settings-governance-approval-lifecycle-other-fixture-bootstrap');

  INSERT INTO public.users (
    id,
    organization_id,
    email,
    full_name,
    user_type,
    access_scope_type,
    access_scope_id
  ) VALUES (
    v_user,
    v_org,
    'settings-governance-' || left(v_user::text, 8) || '@example.com',
    'Settings Governance Operator',
    'ops_admin',
    'tenant',
    NULL
  );

  SELECT role_id
    INTO v_role_id
    FROM public.provision_rbac_roles_from_templates_v1(v_org, ARRAY['ops_admin']::TEXT[], v_user)
   LIMIT 1;

  IF v_role_id IS NOT NULL THEN
    INSERT INTO public.rbac_user_role_assignments (
      organization_id,
      user_id,
      role_id,
      assigned_by_user_id,
      metadata
    ) VALUES (
      v_org,
      v_user,
      v_role_id,
      v_user,
      '{"seed":true,"source":"pgtap","template_key":"ops_admin"}'::jsonb
    )
    ON CONFLICT DO NOTHING;
  END IF;

  PERFORM public.upsert_tenant_domain_event_policy(
    v_org,
    jsonb_build_object(
      'settings_change.requested',
      jsonb_build_object('workflow_template_id', '99990000-0000-0000-0000-000000560020')
    )
  );

  SELECT sv.id
    INTO v_initial_sv
    FROM public.settings_versions sv
   WHERE sv.category = 'ui_presentation_policy'
     AND sv.scope_type = 'tenant'
     AND sv.scope_hash = v_org
     AND sv.approved_at IS NOT NULL
     AND sv.effective_until IS NULL
   ORDER BY sv.version DESC
   LIMIT 1;

  IF v_initial_sv IS NULL THEN
    v_initial_sv := gen_random_uuid();

    INSERT INTO public.settings_versions (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      version,
      value,
      schema_version,
      change_reason,
      approved_by,
      approved_at,
      effective_from
    ) VALUES (
      v_initial_sv,
      'ui_presentation_policy',
      'tenant',
      v_org,
      v_org,
      1,
      jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'review_queue', jsonb_build_object(
          'settings_approval_label', NULL,
          'show_governance_badge', TRUE
        )
      ),
      1,
      'pgTAP initial UI presentation policy',
      v_user,
      now(),
      now()
    );
  ELSE
    UPDATE public.settings_versions
       SET value = COALESCE(value, '{}'::jsonb)
             || jsonb_build_object(
                  'review_queue',
                  jsonb_build_object(
                    'settings_approval_label', NULL,
                    'show_governance_badge', TRUE
                  )
                ),
           change_reason = 'pgTAP initial UI presentation policy',
           approved_by = COALESCE(approved_by, v_user),
           approved_at = COALESCE(approved_at, now()),
           effective_from = COALESCE(effective_from, now())
     WHERE id = v_initial_sv;
  END IF;

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    'ui_presentation_policy',
    'tenant',
    v_org,
    v_org,
    v_initial_sv,
    sv.value,
    now()
    FROM public.settings_versions sv
   WHERE sv.id = v_initial_sv
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
     SET settings_version_id = EXCLUDED.settings_version_id,
         cached_value = EXCLUDED.cached_value,
         last_updated = now();

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT settings_version_id, domain_event_id
    INTO v_pending_sv, v_event
    FROM public.request_settings_change_v1(
      p_category := 'ui_presentation_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'review_queue', jsonb_build_object(
          'settings_approval_label', v_label,
          'show_governance_badge', TRUE
        )
      ),
      p_change_reason := 'pgTAP settings governance approval lifecycle',
      p_effective_from := now()
    );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT workflow_run_id
    INTO v_workflow_run
    FROM public.domain_events
   WHERE id = v_event;

  SELECT id
    INTO v_task
    FROM public.manual_review_tasks
   WHERE task_type = 'settings_approval'
     AND resource_type = 'settings_version'
     AND resource_id = v_pending_sv
     AND status = 'pending'
   ORDER BY created_at DESC
   LIMIT 1;

  SELECT t.id
    INTO v_operator_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE tt.key = 'settings_approval'
     AND t.resource_type = 'settings_version'
     AND t.resource_id = v_pending_sv
     AND t.metadata->>'manual_review_task_id' = v_task::text
   LIMIT 1;

  PERFORM ok(v_pending_sv IS NOT NULL, 'settings change returns pending settings_version_id');
  PERFORM ok(v_event IS NOT NULL, 'settings change returns domain_event_id');
  PERFORM is((SELECT COUNT(*)::INT FROM public.workflow_runs WHERE id = v_workflow_run), 1, 'exactly one settings approval workflow run starts');
  PERFORM is((SELECT COUNT(*)::INT FROM public.manual_review_tasks WHERE id = v_task), 1, 'exactly one settings approval manual review task exists');
  PERFORM is((SELECT COUNT(*)::INT FROM public.tasks WHERE id = v_operator_task), 1, 'exactly one settings approval Review Queue task exists');
  PERFORM is(
    (SELECT tt.key || ':' || t.status FROM public.tasks t JOIN public.task_types tt ON tt.id = t.task_type_id WHERE t.id = v_operator_task),
    'settings_approval:open',
    'Review Queue task is visible through the tasks projection'
  );
  PERFORM ok(
    (SELECT settings_version_id = v_initial_sv AND cached_value #>> '{review_queue,settings_approval_label}' IS NULL
       FROM public.settings
      WHERE category = 'ui_presentation_policy'
        AND scope_type = 'tenant'
        AND scope_hash = v_org),
    'active policy remains unchanged before approval'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.transition_task_v1(
    v_operator_task,
    'completed',
    'pgTAP approved settings governance change',
    jsonb_build_object('action_kind', 'approve'),
    'pgtap-settings-approval-complete-1'
  );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(
    (SELECT status || ':' || resolution_outcome FROM public.manual_review_tasks WHERE id = v_task),
    'resolved:approved',
    'Review Queue completion resolves the backing manual review as approved'
  );
  PERFORM ok(
    (SELECT approved_at IS NOT NULL FROM public.settings_versions WHERE id = v_pending_sv),
    'pending settings version is approved by workflow apply'
  );
  PERFORM ok(
    (SELECT settings_version_id = v_pending_sv AND cached_value #>> '{review_queue,settings_approval_label}' = v_label
       FROM public.settings
      WHERE category = 'ui_presentation_policy'
        AND scope_type = 'tenant'
        AND scope_hash = v_org),
    'approved policy becomes active without manual settings update'
  );
  PERFORM is(
    (SELECT COUNT(*)::INT
       FROM public.decision_log
      WHERE decision_category = 'settings'
        AND decision_point = 'apply'
        AND decision_outcome = 'applied'
        AND resource_id = v_pending_sv),
    1,
    'settings apply decision is written exactly once'
  );

  INSERT INTO public.domain_events (
    id,
    organization_id,
    event_type,
    resource_type,
    resource_id,
    payload,
    status
  ) VALUES (
    v_duplicate_event,
    v_org,
    'settings_change.requested',
    'settings_version',
    v_pending_sv,
    '{}'::jsonb,
    'pending'
  );

  PERFORM is((SELECT status FROM public.domain_events WHERE id = v_duplicate_event), 'skipped', 'duplicate settings event is skipped');
  PERFORM is(
    (SELECT COUNT(DISTINCT workflow_run_id)::INT
       FROM public.domain_events
      WHERE event_type = 'settings_change.requested'
        AND resource_type = 'settings_version'
        AND resource_id = v_pending_sv
        AND workflow_run_id IS NOT NULL),
    1,
    'duplicate event keeps exactly one workflow run for the settings version'
  );
  PERFORM is(
    (SELECT COUNT(*)::INT
       FROM public.manual_review_tasks
      WHERE task_type = 'settings_approval'
        AND resource_type = 'settings_version'
        AND resource_id = v_pending_sv),
    1,
    'duplicate event keeps exactly one manual review task'
  );
  PERFORM is(
    (SELECT COUNT(*)::INT
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.key = 'settings_approval'
        AND t.resource_type = 'settings_version'
        AND t.resource_id = v_pending_sv),
    1,
    'duplicate event keeps exactly one Review Queue task'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT settings_version_id
    INTO v_rejected_sv
    FROM public.request_settings_change_v1(
      p_category := 'ui_presentation_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'review_queue', jsonb_build_object(
          'settings_approval_label', v_rejected_label,
          'show_governance_badge', TRUE
        )
      ),
      p_change_reason := 'pgTAP rejected settings governance lifecycle',
      p_effective_from := now()
    );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  SELECT id
    INTO v_rejected_task
    FROM public.manual_review_tasks
   WHERE task_type = 'settings_approval'
     AND resource_type = 'settings_version'
     AND resource_id = v_rejected_sv
   ORDER BY created_at DESC
   LIMIT 1;

  SELECT t.id
    INTO v_rejected_operator_task
    FROM public.tasks t
    JOIN public.task_types tt
      ON tt.id = t.task_type_id
   WHERE tt.key = 'settings_approval'
     AND t.resource_type = 'settings_version'
     AND t.resource_id = v_rejected_sv
   LIMIT 1;

  PERFORM is((SELECT COUNT(*)::INT FROM public.manual_review_tasks WHERE id = v_rejected_task), 1, 'rejection path creates one manual review task');
  PERFORM is((SELECT COUNT(*)::INT FROM public.tasks WHERE id = v_rejected_operator_task), 1, 'rejection path creates one Review Queue task');

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  PERFORM public.transition_task_v1(
    v_rejected_operator_task,
    'rejected',
    'pgTAP rejected settings governance change',
    jsonb_build_object('action_kind', 'reject'),
    'pgtap-settings-approval-reject-1'
  );

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM is(
    (SELECT status || ':' || resolution_outcome FROM public.manual_review_tasks WHERE id = v_rejected_task),
    'resolved:rejected',
    'Review Queue rejection resolves the backing manual review as rejected'
  );
  PERFORM ok(
    (SELECT approved_at IS NULL FROM public.settings_versions WHERE id = v_rejected_sv),
    'rejected settings version is not approved'
  );
  PERFORM ok(
    (SELECT settings_version_id = v_pending_sv AND cached_value #>> '{review_queue,settings_approval_label}' = v_label
       FROM public.settings
      WHERE category = 'ui_presentation_policy'
        AND scope_type = 'tenant'
        AND scope_hash = v_org),
    'rejected policy never becomes active'
  );
  PERFORM is(
    (SELECT COUNT(*)::INT
       FROM public.decision_log
      WHERE decision_category = 'settings'
        AND decision_point = 'apply'
        AND decision_outcome = 'applied'
        AND resource_id = v_rejected_sv),
    0,
    'rejected settings version has no apply decision'
  );

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    effective_from
  ) VALUES (
    v_non_pending_sv,
    'ui_presentation_policy',
    'tenant',
    v_org,
    v_org,
    99,
    jsonb_build_object('version', 1, 'enabled', TRUE),
    1,
    'pgTAP non-pending hardening',
    now()
  );

  INSERT INTO public.domain_events (
    id,
    organization_id,
    event_type,
    resource_type,
    resource_id,
    payload,
    status
  ) VALUES (
    v_non_pending_event,
    v_org,
    'settings_change.requested',
    'settings_version',
    v_non_pending_sv,
    '{}'::jsonb,
    'processing'
  );

  PERFORM is((SELECT workflow_run_id FROM public.domain_events WHERE id = v_non_pending_event), NULL::uuid, 'non-pending direct domain event is not processed inline');
  PERFORM is(
    (SELECT COUNT(*)::INT
       FROM public.tasks t
       JOIN public.task_types tt ON tt.id = t.task_type_id
      WHERE tt.key = 'settings_approval'
        AND t.resource_id = v_non_pending_sv),
    0,
    'non-pending direct domain event creates no Review Queue task'
  );

  BEGIN
    INSERT INTO public.domain_events (
      organization_id,
      event_type,
      resource_type,
      resource_id,
      payload,
      status
    ) VALUES (
      v_other_org,
      'settings_change.requested',
      'settings_version',
      v_non_pending_sv,
      '{}'::jsonb,
      'pending'
    );
  EXCEPTION
    WHEN others THEN
      v_mismatch_rejected := TRUE;
  END;

  PERFORM ok(v_mismatch_rejected, 'direct domain event insert fails when organization does not own settings_version');
END $$;

SELECT * FROM finish();
ROLLBACK;
