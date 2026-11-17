BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(14);
SELECT ok((SELECT schema #> '{properties,operator_handoff,properties,route_targets,properties,console,properties,path}' IS NOT NULL
  FROM public.schema_registry WHERE category = 'ui_tracking_registry' AND version = 1), 'tracking schema supports the Console handoff');
SELECT is((SELECT cached_value #>> '{operator_handoff,route_targets,console,path}' FROM public.settings
  WHERE category = 'ui_tracking_registry' AND scope_type = 'global' AND scope_id IS NULL), '/operate/shipments', 'retained Console destination is seeded');
SELECT is((SELECT cached_value #>> '{operator_handoff,identifier_param}' FROM public.settings
  WHERE category = 'ui_tracking_registry' AND scope_type = 'global' AND scope_id IS NULL), 'focus', 'retained focus parameter is seeded');
SELECT is((SELECT cached_value #>> '{operator_handoff,identifier_source}' FROM public.settings
  WHERE category = 'ui_tracking_registry' AND scope_type = 'global' AND scope_id IS NULL), 'tracking_number', 'focus comes from the exact tracking row');
SELECT is((SELECT cached_value #>> '{operator_handoff,tab}' FROM public.settings
  WHERE category = 'ui_tracking_registry' AND scope_type = 'global' AND scope_id IS NULL), 'timeline', 'retained timeline target is seeded');
SELECT ok(NOT has_function_privilege('anon', 'public.ui_tracking_registry_v1()', 'EXECUTE'), 'anonymous callers cannot read scoped operator configuration');
SELECT ok(NOT has_function_privilege('anon', 'api.ui_tracking_registry_v1()', 'EXECUTE'), 'anonymous callers cannot use the scoped wrapper');
SELECT ok(NOT (public.public_tracking_config_v1() ? 'operator_handoff'), 'public tracking facade excludes operator configuration');
SELECT ok(has_function_privilege('authenticated', 'api.ui_tracking_registry_v1()', 'EXECUTE'), 'authenticated tracking retains its existing registry access');
CREATE FUNCTION pg_temp.test_handoff_settings_history() RETURNS SETOF TEXT LANGUAGE plpgsql AS $$
DECLARE
  v_current RECORD;
  v_next RECORD;
BEGIN
  SELECT sv.* INTO STRICT v_current FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_tracking_registry' AND s.scope_type = 'global' AND s.scope_id IS NULL;
  SELECT * INTO STRICT v_next FROM public.upsert_settings_value_v1(
    'ui_tracking_registry', 'global', NULL, v_current.value, v_current.schema_version, 'pgTAP handoff history check');
  RETURN NEXT ok((SELECT effective_until > effective_from FROM public.settings_versions WHERE id = v_current.id), 'handoff settings upsert retires the previous active revision');
  RETURN NEXT is((SELECT value FROM public.settings_versions WHERE id = v_current.id), v_current.value, 'handoff settings upsert preserves historical payload');
  RETURN NEXT is((SELECT count(*)::INT FROM public.settings_versions WHERE category = 'ui_tracking_registry'
    AND scope_type = 'global' AND scope_id IS NULL AND approved_at IS NOT NULL AND effective_until IS NULL), 1, 'handoff settings upsert keeps one approved active revision');
END $$;
SELECT * FROM pg_temp.test_handoff_settings_history();
SET LOCAL ROLE anon;
SELECT ok(NOT (api.public_tracking_config_v1() ? 'operator_handoff'), 'real anonymous public facade query omits operator configuration');
SELECT throws_ok($anon$SELECT api.ui_tracking_registry_v1()$anon$, '42501', NULL::TEXT, 'real anonymous caller cannot query scoped operator registry');
RESET ROLE;
SELECT * FROM finish();
ROLLBACK;
