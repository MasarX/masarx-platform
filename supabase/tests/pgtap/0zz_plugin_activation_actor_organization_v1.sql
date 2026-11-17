BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();
-- Rollback-only schema access isolates function ACL denial from schema denial.
GRANT USAGE ON SCHEMA public TO anon;

CREATE TEMP TABLE activation_ids(key TEXT PRIMARY KEY, id UUID DEFAULT gen_random_uuid());
INSERT INTO activation_ids(key) SELECT unnest(ARRAY['org','foreign_org','actor','foreign_actor','platform_actor','denied_actor']);
GRANT SELECT ON activation_ids TO anon, authenticated, service_role;
CREATE FUNCTION pg_temp.activation_id(TEXT) RETURNS UUID LANGUAGE sql AS $$ SELECT id FROM activation_ids WHERE key = $1 $$;
CREATE FUNCTION pg_temp.activation_actor(TEXT) RETURNS VOID LANGUAGE plpgsql AS $$
BEGIN
  PERFORM set_config('request.jwt.claims', jsonb_build_object('sub', pg_temp.activation_id($1), 'role', 'authenticated')::text, true);
  PERFORM set_config('request.jwt.claim.sub', pg_temp.activation_id($1)::text, true);
  PERFORM set_config('request.jwt.claim.role', 'authenticated', true);
END;
$$;
INSERT INTO public.organizations(id, name, slug)
SELECT id, 'Synthetic activation tenant', 'activation-' || id FROM activation_ids WHERE key IN ('org','foreign_org');
INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT id, pg_temp.activation_id(CASE WHEN key IN ('foreign_actor','platform_actor') THEN 'foreign_org' ELSE 'org' END),
  'activation-' || id || '@example.test', 'Synthetic activation actor',
  CASE WHEN key = 'denied_actor' THEN 'sender_user' ELSE 'ops_admin' END, 'active',
  CASE WHEN key = 'platform_actor' THEN 'platform' ELSE 'tenant' END
FROM activation_ids WHERE key IN ('actor','foreign_actor','platform_actor','denied_actor');
DO $policy$
DECLARE policy JSONB; schema_version INT;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT policy, schema_version
  FROM public.settings s JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy' AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin'
    THEN jsonb_set(role, '{capability_keys}', '["integration_plugins.activate","integration_plugins.write"]')
    WHEN role->>'key' = 'sender_user' THEN jsonb_set(role, '{capability_keys}', '[]') ELSE role END ORDER BY n))
  INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY r(role,n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', id, policy, schema_version, 'Synthetic activation policy')
  FROM activation_ids WHERE key IN ('org','foreign_org');
END;
$policy$;
CREATE TEMP TABLE activation_targets AS SELECT kind, gen_random_uuid() plugin, gen_random_uuid() version,
  'activation-' || gen_random_uuid() workflow FROM unnest(ARRAY['own','platform','service']) kind;
GRANT SELECT ON activation_targets TO anon, authenticated, service_role;
INSERT INTO public.workflow_templates(name, version, status, scope_type, scope_id)
SELECT workflow, 1, 'active', 'tenant', pg_temp.activation_id('org') FROM activation_targets;
INSERT INTO public.integration_plugins(id, organization_id, plugin_key, name, plugin_kind)
SELECT plugin, pg_temp.activation_id('org'), 'activation-' || plugin, 'Synthetic plugin', 'webhook' FROM activation_targets;
INSERT INTO public.integration_plugin_versions(id, plugin_id, organization_id, version_no, status, workflow_binding)
SELECT version, plugin, pg_temp.activation_id('org'), 1, 'approved', jsonb_build_object('template_name', workflow) FROM activation_targets;

SELECT ok(NOT has_function_privilege(role, 'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)', 'EXECUTE'),
  role || ' cannot execute core') FROM unnest(ARRAY['anon','authenticated','service_role']) role;
SELECT ok(NOT has_function_privilege('anon', signature, 'EXECUTE'), 'anon denied: ' || signature)
FROM unnest(ARRAY['public.integration_plugin_activate_v1(uuid,text,uuid,text)', 'api.integration_plugin_activate_v1(uuid,text,uuid,text)']) signature;
SELECT ok(NOT prosecdef, 'API activation wrapper remains invoker') FROM pg_proc
WHERE oid = 'api.integration_plugin_activate_v1(uuid,text,uuid,text)'::regprocedure;
SELECT ok(prosecdef AND provolatile = 'v' AND prorettype = 'jsonb'::regtype
  AND proconfig @> ARRAY['search_path=public, extensions, pg_temp','row_security=on'],
  proname || ' preserves execution attributes') FROM pg_proc
WHERE oid IN ('public.integration_plugin_activate_v1(uuid,text,uuid,text)'::regprocedure,
  'public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure);

SELECT pg_temp.activation_actor('foreign_actor');
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('integration_plugins.activate','tenant',pg_temp.activation_id('foreign_org')),
  'foreign actor really has activation capability in its own organization');
SELECT throws_ok(format('SELECT api.integration_plugin_activate_v1(%L::uuid)', version), '42501',
  'Capability denied: integration_plugins.activate', 'foreign plugin uses capability-denied class without tenant details')
FROM activation_targets WHERE kind = 'own';
SELECT throws_ok(format('SELECT api.integration_plugin_activate_v1(%L::uuid)', gen_random_uuid()), '42501',
  'Capability denied: integration_plugins.activate', 'unknown plugin has the same denial as foreign plugin');
RESET ROLE;
SELECT throws_ok(format('SELECT public.integration_plugin_activate_core_v1(%L::uuid)', version), '42501',
  'Capability denied: integration_plugins.activate', 'owner-only core also enforces actor organization') FROM activation_targets WHERE kind = 'own';
SELECT is((SELECT status FROM public.integration_plugin_versions WHERE id = (SELECT version FROM activation_targets WHERE kind = 'own')),
  'approved', 'denied activation leaves version unchanged');
SELECT is((SELECT count(*) FROM public.integration_plugin_bindings WHERE plugin_version_id IN (SELECT version FROM activation_targets)),
  0::bigint, 'denied activation materializes no bindings');
SELECT pg_temp.activation_actor('denied_actor');
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.integration_plugin_activate_v1(%L::uuid)', version), '42501',
  'Capability denied: integration_plugins.activate', 'same-organization actor still needs capability') FROM activation_targets WHERE kind = 'own';
RESET ROLE;
SELECT pg_temp.activation_actor('actor');
SET LOCAL ROLE authenticated;
SELECT is(api.integration_plugin_activate_v1(version, 'tenant', pg_temp.activation_id('org'))->>'ok', 'true',
  'authorized same-organization API call activates through the owner-only core') FROM activation_targets WHERE kind = 'own';
SELECT throws_ok(format('SELECT public.integration_plugin_activate_core_v1(%L::uuid)', version), '42501',
  'permission denied for function integration_plugin_activate_core_v1', 'authenticated actor cannot bypass wrapper') FROM activation_targets WHERE kind = 'own';
RESET ROLE;
SELECT pg_temp.activation_actor('platform_actor');
SET LOCAL ROLE authenticated;
SELECT ok(public.is_platform_user(), 'platform fixture uses the canonical platform helper');
SELECT is(api.integration_plugin_activate_v1(version, 'tenant', pg_temp.activation_id('org'))->>'ok', 'true',
  'platform exception retains capability and scope checks') FROM activation_targets WHERE kind = 'platform';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claim.sub', '', true);
SET LOCAL ROLE service_role;
SELECT is(api.integration_plugin_activate_v1(version, 'tenant', pg_temp.activation_id('org'))->>'ok', 'true',
  'service exception activates through the public owner wrapper') FROM activation_targets WHERE kind = 'service';
RESET ROLE;
SELECT set_config('request.jwt.claims', '{"role":"anon"}', true);
SELECT set_config('request.jwt.claim.role', 'anon', true);
SET LOCAL ROLE anon;
SELECT throws_ok(format('SELECT public.integration_plugin_activate_v1(%L::uuid)', version), '42501',
  'permission denied for function integration_plugin_activate_v1', 'anon cannot activate') FROM activation_targets WHERE kind = 'own';
SELECT throws_ok(format('SELECT public.integration_plugin_activate_core_v1(%L::uuid)', version), '42501',
  'permission denied for function integration_plugin_activate_core_v1', 'anon cannot execute core') FROM activation_targets WHERE kind = 'own';
RESET ROLE;
SELECT finish();
ROLLBACK;
