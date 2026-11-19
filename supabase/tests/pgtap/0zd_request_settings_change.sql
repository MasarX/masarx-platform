-- Test Suite: request_settings_change_v1 (settings_versions + domain_events)
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE FUNCTION pg_temp.settings_request_tap() RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_sv UUID;
  v_event UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true);

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Settings Request Org', 'settings-request-org-' || left(v_org::text, 8));

  PERFORM set_config('app.organization_onboarding_source', '', true);

  INSERT INTO clients (id, organization_id, name, slug, status)
  VALUES (
    v_client,
    v_org,
    'Settings Request Client',
    'settings-request-client-' || left(v_client::text, 8),
    'active'
  );

  INSERT INTO senders (id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (
    v_sender,
    v_client,
    'Settings Request Sender',
    'Settings Request Sender',
    TRUE,
    'active'
  );

  PERFORM bootstrap_tenant_onboarding_v1(
    v_org,
    'pgtap:request-settings-change-fixture-bootstrap'
  );

  INSERT INTO users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'settings-request-' || left(v_user::text, 8) || '@example.com',
    'Settings Request User',
    'tenant',
    NULL
  );

  EXECUTE 'SET CONSTRAINTS ALL IMMEDIATE';

  RETURN NEXT is(
    COALESCE(public.resolve_domain_event_policy(
      '00000000-0000-0000-0000-000000000000'::uuid,
      'settings_change.requested'
    )->>'workflow_template_id', ''),
    '99990000-0000-0000-0000-000000560020',
    'global domain_event_policy maps settings_change.requested to settings approval workflow'
  );

  PERFORM public.upsert_tenant_domain_event_policy(
    v_org,
    jsonb_build_object(
      'settings_change.requested',
      jsonb_build_object('workflow_template_id', '99990000-0000-0000-0000-000000560020')
    )
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT settings_version_id, domain_event_id
    INTO v_sv, v_event
    FROM public.request_settings_change_v1(
      p_category := 'domain_event_policy',
      p_scope_type := 'tenant',
      p_scope_id := v_org,
      p_value := jsonb_build_object('events', jsonb_build_object('integration.settings_request', jsonb_build_object('workflow_template_id', gen_random_uuid()))),
      p_change_reason := 'integration test request',
      p_effective_from := now()
    );

  RETURN NEXT ok(v_sv IS NOT NULL, 'request_settings_change_v1 returns settings_version_id');
  RETURN NEXT ok(v_event IS NOT NULL, 'request_settings_change_v1 returns domain_event_id');

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.settings_versions WHERE id = v_sv),
    1,
    'settings_versions row inserted'
  );

  RETURN NEXT ok(
    (SELECT approved_at IS NULL AND requested_by = v_user FROM public.settings_versions WHERE id = v_sv LIMIT 1),
    'settings_versions starts unapproved and requested_by is captured'
  );

  RETURN NEXT is(
    (SELECT COUNT(*)::INT FROM public.domain_events
      WHERE id = v_event AND event_type = 'settings_change.requested'
        AND resource_type = 'settings_version' AND resource_id = v_sv
        AND status = 'processing' AND workflow_run_id IS NOT NULL),
    1,
    'settings_change.requested starts the inline approval workflow'
  );
END $$;
SELECT * FROM pg_temp.settings_request_tap();

SELECT * FROM finish();
ROLLBACK;

