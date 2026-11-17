BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();

SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'label_provider'
  AND jsonb_path_exists(value, '$.**.invoke_secret')), 'migration removed inline secrets from every historical settings version');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings WHERE category = 'label_provider'
  AND jsonb_path_exists(cached_value, '$.**.invoke_secret')), 'migration removed inline secrets from every active settings cache');
SELECT ok(EXISTS (SELECT 1 FROM public.settings WHERE category = 'label_provider'
  AND cached_value#>>'{providers,0,invoke_secret_ref,type}' = 'SecretRef'), 'inherited renderer settings now hold a Vault reference');

CREATE TEMP TABLE label_vault_fixture AS SELECT gen_random_uuid() org, gen_random_uuid() foreign_org,
  gen_random_uuid() actor, public.get_root_scope_type_key_v1() root_scope;
GRANT SELECT ON label_vault_fixture TO authenticated, service_role;
CREATE TEMP TABLE label_requests(kind TEXT, version UUID, event UUID);
GRANT INSERT, SELECT ON label_requests TO authenticated;
INSERT INTO public.organizations(id, name, slug)
SELECT org, 'Synthetic renderer tenant', 'renderer-' || org FROM label_vault_fixture
UNION ALL SELECT foreign_org, 'Synthetic renderer other tenant', 'renderer-' || foreign_org FROM label_vault_fixture;
INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT actor, org, 'renderer-' || actor || '@example.test', 'Synthetic renderer actor', 'ops_admin', 'active', 'tenant' FROM label_vault_fixture;
DO $policy$
DECLARE policy JSONB; schema_version INT;
BEGIN
  SELECT v.value,v.schema_version INTO STRICT policy,schema_version FROM public.settings s
  JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy' AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin'
    THEN jsonb_set(role, '{capability_keys}', '["settings.read","settings.write"]') ELSE role END ORDER BY n))
  INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY r(role,n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', org, policy, schema_version, 'Synthetic renderer policy') FROM label_vault_fixture;
END;
$policy$;
UPDATE public.settings_category_registry SET request_capability = 'settings.write' WHERE category = 'label_provider';
SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings s CROSS JOIN label_vault_fixture f
  WHERE s.category = 'label_provider' AND s.scope_type = 'tenant' AND s.scope_id = f.org),
  'tenant initially has no renderer override');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.onboarding_policy_categories_v1(public.resolve_saas_onboarding_policy_v1(),'tenant')
  WHERE category = 'label_provider'), 'bootstrap inherits renderer configuration instead of copying the global credential');

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true);
SELECT set_config('request.jwt.claim.role', 'service_role', true);
SET LOCAL ROLE service_role;
SELECT lives_ok($q$SELECT public.upsert_label_provider_settings_v1('global',NULL,
  '{"version":1,"providers":[{"name":"synthetic","invoke_url":"https://renderer.example.test/functions/v1/label-renderer","invoke_secret":"synthetic-label-global-credential","timeout_ms":15000}]}', 'Synthetic global renderer')$q$,
  'real service writer stores the global renderer credential');
SELECT is(public.resolve_label_renderer_invoke_config_v1(org)->>'invoke_secret', 'synthetic-label-global-credential',
  'service resolves the global Vault credential for tenant fallback') FROM label_vault_fixture;
SELECT is(public.resolve_label_renderer_invoke_request_v1(1,jsonb_build_object('organization_id',org))#>>'{headers,authorization}',
  'Bearer synthetic-label-global-credential', 'request resolver builds authorization from Vault') FROM label_vault_fixture;
RESET ROLE;
SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings_versions WHERE category = 'label_provider'
  AND position('synthetic-label-global-credential' IN value::text) > 0), 'global credential never enters any settings version');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings WHERE category = 'label_provider'
  AND position('synthetic-label-global-credential' IN cached_value::text) > 0), 'global credential never enters any readable cache');
CREATE TEMP TABLE label_vault_before AS SELECT count(*) n FROM vault.secrets WHERE starts_with(name,'label_provider/');
UPDATE public.settings_versions SET value = value WHERE category = 'label_provider';
UPDATE public.settings SET cached_value = cached_value WHERE category = 'label_provider';
SELECT is((SELECT count(*) FROM vault.secrets WHERE starts_with(name,'label_provider/')), (SELECT n FROM label_vault_before),
  'replaying the storage conversion creates no additional Vault entries');

SELECT set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true) FROM label_vault_fixture;
SELECT set_config('request.jwt.claim.sub', actor::text, true) FROM label_vault_fixture;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('settings.read','tenant',org), 'tenant fixture really has settings.read') FROM label_vault_fixture;
SELECT is(api.ui_settings_preview_v1('label_provider','tenant',org)#>>'{value,providers,0,invoke_secret_ref}',
  'REDACTED', 'global fallback preview exposes only credential presence') FROM label_vault_fixture;
SELECT ok(position('synthetic-label-global-credential' IN api.ui_list_resource_v1('settings_category_registry')::text) = 0,
  'registry-driven settings category list exposes no credential');
SELECT throws_ok($q$SELECT public.resolve_settings('label_provider','global',NULL)$q$, '42501',
  'permission denied for function resolve_settings', 'tenant cannot call the raw settings resolver');
SELECT throws_ok('SELECT public.resolve_label_renderer_invoke_config_v1(NULL)', '42501',
  'permission denied for function resolve_label_renderer_invoke_config_v1', 'tenant cannot call the secret-bearing service resolver');
SELECT throws_ok(format('SELECT public.request_settings_change_v1(%L,%L,%L::uuid,(api.ui_settings_preview_v1(%L,%L,%L::uuid)->%L))',
  'label_provider','tenant',org,'label_provider','tenant',org,'value'), '23514',
  'Label provider credential must be set for this scope', 'global credential cannot be inherited into a tenant-controlled override') FROM label_vault_fixture;
SELECT lives_ok(format($q$INSERT INTO label_requests SELECT 'initial',settings_version_id,domain_event_id FROM api.request_settings_change_v1(
  'label_provider','tenant',%L::uuid,'{"version":1,"providers":[{"name":"synthetic","invoke_url":"https://renderer.example.test/functions/v1/label-renderer","invoke_secret":"synthetic-label-tenant-credential"}]}')$q$,org),
  'browser request writes a tenant secret through the authorized database boundary') FROM label_vault_fixture;
RESET ROLE;
SELECT ok((SELECT value#>>'{providers,0,invoke_secret_ref,type}' = 'SecretRef'
  AND NOT jsonb_path_exists(value,'$.**.invoke_secret') FROM public.settings_versions WHERE id = (SELECT version FROM label_requests WHERE kind = 'initial')),
  'pending request value stores only the scoped Vault reference');
SELECT lives_ok(format($q$SELECT public.upsert_label_provider_settings_v1('tenant',%L::uuid,
  '{"version":1,"providers":[{"name":"synthetic","invoke_url":"https://renderer.example.test/functions/v1/label-renderer","invoke_secret":"synthetic-label-tenant-credential"}]}','Synthetic active tenant renderer')$q$,org),
  'trusted provisioning creates the active tenant override') FROM label_vault_fixture;

SET LOCAL ROLE authenticated;
SELECT lives_ok(format($q$INSERT INTO label_requests SELECT 'unchanged',settings_version_id,domain_event_id FROM api.request_settings_change_v1(
  'label_provider','tenant',%L::uuid,jsonb_set(api.ui_settings_preview_v1('label_provider','tenant',%L::uuid)->'value',
  '{providers,0,invoke_url}','"https://renderer.example.test/updated"'))$q$,org,org),
  'same-scope preview marker means unchanged credential during URL-only save') FROM label_vault_fixture;
SELECT throws_ok(format($q$SELECT public.request_settings_change_v1('label_provider','tenant',%L::uuid,
  '{"providers":[{"name":"synthetic","invoke_secret":"synthetic-label-forbidden"}]}')$q$,foreign_org),
  '42501','resolve_settings_scope_context_v1 cannot target another organization','foreign-scope secret writer is refused') FROM label_vault_fixture;
RESET ROLE;
SELECT is(public.resolve_label_provider_invoke_secret_v1(value->'providers'->0),'synthetic-label-tenant-credential',
  'unchanged request retains exactly the tenant credential') FROM public.settings_versions WHERE id = (SELECT version FROM label_requests WHERE kind = 'unchanged');
SELECT throws_ok(format($q$SELECT public.upsert_label_provider_settings_v1('tenant',%L::uuid,%L::jsonb,'Synthetic forbidden reference')$q$,
  f.org,jsonb_build_object('providers',jsonb_build_array(jsonb_build_object('name','synthetic','invoke_secret_ref',s.cached_value#>'{providers,0,invoke_secret_ref}')))),
  '42501','Label provider credential reference outside settings scope','global Vault reference cannot be installed at tenant scope')
FROM label_vault_fixture f JOIN public.settings s ON s.category = 'label_provider' AND s.scope_type = f.root_scope AND s.scope_id IS NULL;
SELECT throws_ok($q$SELECT public.upsert_label_provider_settings_v1('global',NULL,'{"secret":"synthetic-label-inline"}','Synthetic invalid inline secret')$q$,
  '23514','Inline credentials are not allowed in executable configuration; use an auth binding','unrecognized inline secret fields fail closed');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.audit_table_changes WHERE table_name IN ('settings','settings_versions')
  AND (position('synthetic-label-global-credential' IN COALESCE(row_old::text,'') || COALESCE(row_new::text,'')) > 0
    OR position('synthetic-label-tenant-credential' IN COALESCE(row_old::text,'') || COALESCE(row_new::text,'')) > 0)),
  'settings audit snapshots never persist either plaintext credential');
SELECT ok(NOT has_function_privilege(role,signature,'EXECUTE'), role || ' denied: ' || signature)
FROM unnest(ARRAY['anon','authenticated']) role CROSS JOIN unnest(ARRAY[
  'public.label_provider_seal_value_v1(jsonb,text,uuid,jsonb)', 'public.resolve_label_provider_invoke_secret_v1(jsonb)',
  'public.upsert_label_provider_settings_v1(text,uuid,jsonb,text)']) signature;
SELECT ok(position('public.resolve_label_provider_invoke_secret_v1' IN pg_get_functiondef('public.ops_sweeper_label_renderer_cron_guard(jsonb)'::regprocedure)) > 0,
  'cron guard reads the canonical Vault credential path');
SELECT ok(position('public.invoke_label_renderer(integer,jsonb)' IN pg_get_functiondef('public.ops_sweeper_label_renderer_cron_guard(jsonb)'::regprocedure)) > 0,
  'cron guard checks the current renderer dispatch signature');
SELECT public.upsert_label_provider_settings_v1('tenant',foreign_org,
  '{"version":1,"providers":[{"name":"synthetic","invoke_url":"https://renderer.example.test/functions/v1/label-renderer","invoke_secret":"synthetic-label-global-credential"}]}',
  'Synthetic legacy global credential snapshot') FROM label_vault_fixture;
SELECT public.upsert_label_provider_settings_v1('global',NULL,
  '{"version":1,"providers":[{"name":"synthetic","invoke_url":"https://renderer.example.test/functions/v1/label-renderer","invoke_secret":"synthetic-label-next-global-credential"}]}',
  'Synthetic global credential rotation');
SELECT throws_ok(format('SELECT public.upsert_label_provider_settings_v1(%L,%L::uuid,%L::jsonb,%L)', 'tenant',f.foreign_org,
  jsonb_set(s.cached_value,'{providers,0,invoke_url}','"https://untrusted.example.test/collect"'::jsonb), 'Synthetic prohibited credential redirect'),
  '42501','Global label credential requires its configured endpoint','legacy global credential cannot be redirected even after global rotation')
FROM label_vault_fixture f JOIN public.settings s ON s.category = 'label_provider' AND s.scope_type = 'tenant' AND s.scope_id = f.foreign_org;
SELECT finish();
ROLLBACK;
