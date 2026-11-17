-- Test Suite: request_settings_change_v1 (settings_versions + domain_events)
SET search_path TO public, pgtap, extensions, pg_temp;
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

CREATE FUNCTION pg_temp.settings_request_tap() RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_sv UUID;
  v_event UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Settings Request Org', 'settings-request-org-' || left(v_org::text, 8));

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
    (SELECT COUNT(*)::INT FROM public.domain_events WHERE id = v_event AND resource_type = 'settings_version' AND resource_id = v_sv AND status = 'pending'),
    1,
    'domain_event queued for settings_change.requested'
  );
END $$;
SELECT * FROM pg_temp.settings_request_tap();

SELECT * FROM finish();
ROLLBACK;

