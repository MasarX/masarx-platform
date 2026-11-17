BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT no_plan();

CREATE TEMP TABLE preview_fixture AS
SELECT gen_random_uuid() org, gen_random_uuid() foreign_org, gen_random_uuid() actor,
  public.get_root_scope_type_key_v1() root_scope;
GRANT SELECT ON preview_fixture TO authenticated;
INSERT INTO public.organizations(id, name, slug)
SELECT org, 'Synthetic settings tenant', 'preview-' || org FROM preview_fixture
UNION ALL SELECT foreign_org, 'Synthetic foreign tenant', 'preview-' || foreign_org FROM preview_fixture;
INSERT INTO public.users(id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT actor, org, 'preview-' || actor || '@example.test', 'Synthetic preview actor', 'ops_admin', 'active', 'tenant'
FROM preview_fixture;

DO $policy$
DECLARE policy JSONB; schema_version INT;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT policy, schema_version
  FROM public.settings s JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy' AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin'
    THEN jsonb_set(role, '{capability_keys}', '["settings.read","settings.write"]') ELSE role END ORDER BY n))
    INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY r(role, n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', f.org, policy, schema_version, 'Synthetic preview policy')
  FROM preview_fixture f;
END;
$policy$;

INSERT INTO public.schema_registry(category, version, schema)
VALUES ('security_preview_fixture', 1, '{"type":"object"}'), ('security_preview_plain', 1, '{"type":"object"}');
UPDATE public.settings_category_registry SET request_capability = 'settings.write'
WHERE category IN ('security_preview_fixture', 'security_preview_plain', 'label_provider');
SELECT public.upsert_settings_value_v1('security_preview_fixture', 'tenant', org,
  '{"invoke_secret":"synthetic-preview-top","nested":[{"clientSecret":"synthetic-preview-nested","password":"synthetic-preview-password","api_key":"synthetic-preview-key"}],"authorization":"Bearer synthetic-preview-header","opaque":"Bearer synthetic-preview-opaque","reference":{"type":"SecretRef","id":"00000000-0000-0000-0000-000000000001"},"credentials_vault_id":"00000000-0000-0000-0000-000000000002","enabled":true,"empty_secret":"","null_secret":null}',
  1, 'Synthetic secret preview') FROM preview_fixture;
SELECT public.upsert_settings_value_v1('security_preview_plain', 'tenant', org,
  '{"page_size":25,"enabled":true,"empty":[],"nested":{"label":"synthetic"},"header_allowlist":["authorization","x-api-key"]}',
  1, 'Synthetic ordinary preview') FROM preview_fixture;

-- Reproduce inherited global label_provider fallback without a tenant override.
SELECT public.upsert_settings_value_v1('label_provider', public.get_root_scope_type_key_v1(), NULL::uuid,
  '{"providers":[{"invoke_url":"https://example.test/render","invoke_secret":"synthetic-platform-wide-renderer-secret"}]}',
  (SELECT max(version) FROM public.schema_registry WHERE category = 'label_provider' AND is_active),
  'Synthetic global renderer secret');
SELECT ok(NOT EXISTS (SELECT 1 FROM public.settings s CROSS JOIN preview_fixture f
  WHERE s.category = 'label_provider' AND s.scope_type = 'tenant' AND s.scope_id = f.org),
  'tenant fixture has no label provider override');
CREATE TEMP TABLE preview_before AS SELECT count(*) n FROM public.settings_versions;

SELECT set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true) FROM preview_fixture;
SELECT set_config('request.jwt.claim.sub', actor::text, true) FROM preview_fixture;
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SET LOCAL ROLE authenticated;
SELECT ok(public.user_has_capability_v1('settings.read', 'tenant', org), 'fixture really has settings.read') FROM preview_fixture;
SELECT is(api.ui_settings_preview_v1('label_provider', 'tenant', org)#>>'{value,providers,0,invoke_secret_ref}',
  'REDACTED', 'tenant fallback never exposes the platform-wide renderer secret') FROM preview_fixture;
SELECT is(api.ui_settings_preview_v1('label_provider', 'tenant', org)->>'scope_type',
  root_scope, 'redacted renderer preview still identifies the global winning scope') FROM preview_fixture;
SELECT ok(position('synthetic-platform-wide-renderer-secret' IN api.ui_settings_preview_v1('label_provider', 'tenant', org)::text) = 0,
  'global secret is absent from the entire API response') FROM preview_fixture;
SELECT is(api.ui_settings_preview_v1('security_preview_fixture', 'tenant', org)->'value',
  '{"invoke_secret":"REDACTED","nested":[{"clientSecret":"REDACTED","password":"REDACTED","api_key":"REDACTED"}],"authorization":"REDACTED","opaque":"REDACTED","reference":"REDACTED","credentials_vault_id":"REDACTED","enabled":true,"empty_secret":"","null_secret":null}'::jsonb,
  'API preview recursively exposes presence, including arrays, bearer values and Vault references') FROM preview_fixture;
SELECT is(public.ui_settings_preview_v1('security_preview_plain', 'tenant', org)->'value',
  '{"page_size":25,"enabled":true,"empty":[],"nested":{"label":"synthetic"},"header_allowlist":["authorization","x-api-key"]}'::jsonb,
  'non-secret category is unchanged') FROM preview_fixture;
SELECT throws_ok(format('SELECT api.ui_settings_preview_v1(%L,%L,%L::uuid)', 'security_preview_fixture', 'tenant', foreign_org),
  '42501', 'resolve_settings_scope_context_v1 cannot target another organization', 'foreign preview scope remains refused') FROM preview_fixture;
SELECT throws_ok(format('SELECT public.request_settings_change_v1(%L,%L,%L::uuid,%L::jsonb)',
  'security_preview_fixture', 'tenant', org, '{"nested":[{"invoke_secret":"REDACTED"}]}'),
  '23514', 'Settings preview markers cannot be saved; submit explicit values', 'nested preview marker cannot be persisted') FROM preview_fixture;
SELECT throws_ok(format('SELECT public.request_settings_change_v1(%L,%L,%L::uuid,(api.ui_settings_preview_v1(%L,%L,%L::uuid)->%L))',
  'label_provider', 'tenant', org, 'label_provider', 'tenant', org, 'value'),
  '23514', 'Label provider credential must be set for this scope', 'global label provider credential cannot be copied into a tenant override') FROM preview_fixture;
RESET ROLE;
SELECT is((SELECT count(*) FROM public.settings_versions), (SELECT n FROM preview_before),
  'rejected round trips create no settings versions');
SELECT is(public.settings_preview_redact_v1(jsonb_build_object(key, 'synthetic-sensitive-value')),
  jsonb_build_object(key, 'REDACTED'), 'canonical sensitive key is redacted: ' || key)
FROM unnest(ARRAY['secret','invoke_secret','client_secret','access_token','refreshToken','password','api_key',
  'apiKey','authorization','credentials','credentials_vault_id','signing_secret','private_key','x-api-key']) key;
SELECT is(public.settings_preview_redact_v1('{"keep":false,"zero":0,"empty":{},"items":[1,null,"ordinary"]}'),
  '{"keep":false,"zero":0,"empty":{},"items":[1,null,"ordinary"]}'::jsonb, 'ordinary JSON types survive');
SET LOCAL ROLE authenticated;
SELECT lives_ok(format('SELECT public.request_settings_change_v1(%L,%L,%L::uuid,%L::jsonb)',
  'security_preview_fixture', 'tenant', org, '{"invoke_secret":"synthetic-explicit-replacement","enabled":true}'),
  'explicit secret replacement can still request a settings change') FROM preview_fixture;
RESET ROLE;
SELECT finish();
ROLLBACK;
