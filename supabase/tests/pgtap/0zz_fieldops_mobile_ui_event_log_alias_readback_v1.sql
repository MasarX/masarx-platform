-- pgTAP: FieldOps Mobile V2 route/contact UI events persist with mobile payload aliases.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

CREATE OR REPLACE FUNCTION pg_temp.test_fieldops_mobile_ui_event_log_alias_readback_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_inserted INTEGER;
  v_api_inserted INTEGER;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Mobile Event Alias Org', 'mobile-event-alias-' || left(v_org::text, 8));

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type)
  VALUES (
    v_user,
    v_org,
    'mobile-event-alias-' || left(v_user::text, 8) || '@example.com',
    'Mobile Event Alias Driver',
    'tenant'
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.ui_log_events_v1(
    jsonb_build_array(
      jsonb_build_object(
        'event_type', 'mobile_route_contact',
        'captured_at', '2026-05-29T10:00:00.000Z',
        'metadata', jsonb_build_object(
          'app', 'fieldops',
          'contact_role', 'dispatcher',
          'contact_source', 'task_context',
          'route_stop_id', '11111111-1111-1111-1111-111111111111'
        )
      ),
      jsonb_build_object(
        'type', 'mobile_route_navigate',
        'meta', jsonb_build_object(
          'app', 'fieldops',
          'provider', 'google_maps',
          'route_run_id', '22222222-2222-2222-2222-222222222222'
        )
      )
    ),
    'mobile'
  )
  INTO v_inserted;

  RETURN NEXT is(v_inserted, 2, 'ui_log_events_v1 inserts mobile alias and canonical event payloads');

  SELECT api.ui_log_events_v1(
    jsonb_build_array(
      jsonb_build_object(
        'event_type', 'mobile_route_contact',
        'captured_at', '2026-05-29T10:01:00.000Z',
        'metadata', jsonb_build_object(
          'app', 'fieldops',
          'contact_role', 'support',
          'contact_source', 'mobile_v2_native_shell',
          'route_stop_id', '33333333-3333-3333-3333-333333333333'
        )
      )
    ),
    'mobile'
  )
  INTO v_api_inserted;

  RETURN NEXT is(v_api_inserted, 1, 'api.ui_log_events_v1 inserts Mobile V2 event payloads');
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.ui_event_log WHERE organization_id = v_org AND app = 'mobile'),
    3,
    'ui_event_log stores public and API Mobile V2 route support events'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.ui_event_log
      WHERE organization_id = v_org
        AND event_type = 'mobile_route_contact'
        AND meta->>'contact_role' = 'dispatcher'
        AND meta->>'contact_source' = 'task_context'
        AND meta->>'route_stop_id' = '11111111-1111-1111-1111-111111111111'
    ),
    'event_type/metadata mobile contact payload is persisted with route/task contact metadata'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.ui_event_log
      WHERE organization_id = v_org
        AND event_type = 'mobile_route_navigate'
        AND meta->>'provider' = 'google_maps'
        AND meta->>'route_run_id' = '22222222-2222-2222-2222-222222222222'
    ),
    'canonical type/meta route navigation payload still persists'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
      FROM public.ui_event_log
      WHERE organization_id = v_org
        AND event_type = 'mobile_route_contact'
        AND meta->>'contact_role' = 'support'
        AND meta->>'contact_source' = 'mobile_v2_native_shell'
        AND meta->>'route_stop_id' = '33333333-3333-3333-3333-333333333333'
    ),
    'api wrapper persists Mobile V2 native-shell contact metadata'
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.ui_event_log WHERE organization_id = v_org AND event_type = 'mobile_route_contact'),
    2,
    'mobile contact event is not silently dropped'
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.ui_event_log WHERE organization_id = v_org AND event_type = 'mobile_route_navigate'),
    1,
    'mobile navigation event is not silently dropped'
  );
  RETURN NEXT is(
    (SELECT count(*)::int FROM public.ui_event_log WHERE organization_id = v_org AND event_type IS NULL),
    0,
    'no null event_type rows are written'
  );
END
$function$;

SELECT * FROM pg_temp.test_fieldops_mobile_ui_event_log_alias_readback_v1();

SELECT * FROM finish();
ROLLBACK;
