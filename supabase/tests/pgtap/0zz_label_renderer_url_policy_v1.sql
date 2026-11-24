BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

CREATE TEMP TABLE renderer_url_case AS
SELECT gen_random_uuid() AS org, gen_random_uuid() AS actor,
  encode(gen_random_bytes(20), 'hex') AS credential,
  concat('https', '://', concat_ws('.', 'renderer', 'example', 'test'), '/functions/v1/label-renderer') AS public_url,
  concat('https', '://', concat_ws('.', 127, 0, 0, 1), '/functions/v1/label-renderer') AS rejected_url,
  current_setting('app.local_label_renderer_url') AS local_url,
  replace(current_setting('app.local_label_renderer_url'), '/functions/v1/label-renderer',
    '/unconfigured/functions/v1/label-renderer') AS unconfigured_local_url;

INSERT INTO public.organizations (id, name, slug)
SELECT org, 'Renderer URL fixture', 'renderer-url-' || org FROM renderer_url_case;
INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT actor, org, concat(actor, chr(64), concat_ws('.', 'example', 'test')),
  'Renderer URL fixture', 'ops_admin', 'active', 'tenant' FROM renderer_url_case;

DO $fixture$
DECLARE
  policy jsonb;
  schema_version integer;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT policy, schema_version
  FROM public.settings s JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy' AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;
  SELECT jsonb_set(policy, '{roles}', jsonb_agg(CASE WHEN role->>'key' = 'ops_admin'
    THEN jsonb_set(role, '{capability_keys}', '["settings.read","settings.write"]') ELSE role END ORDER BY n))
  INTO policy FROM jsonb_array_elements(policy->'roles') WITH ORDINALITY r(role, n);
  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', org, policy, schema_version, 'Renderer URL fixture')
  FROM renderer_url_case;
END;
$fixture$;

UPDATE public.settings_category_registry SET request_capability = 'settings.write' WHERE category = 'label_provider';
CREATE TEMP TABLE renderer_url_payloads AS
SELECT f.org, entry.kind, jsonb_build_object('version', 1, 'providers', jsonb_build_array(jsonb_build_object(
  'name', 'renderer-url-fixture', 'invoke_url', entry.url, 'invoke_secret', f.credential))) AS value
FROM renderer_url_case f CROSS JOIN LATERAL (VALUES ('public', public_url), ('private', rejected_url),
  ('local', local_url), ('unconfigured_local', unconfigured_local_url)) entry(kind, url);
GRANT SELECT ON renderer_url_payloads TO authenticated;

SELECT set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', actor::text, true), set_config('request.jwt.claim.role', 'authenticated', true)
FROM renderer_url_case;
SET LOCAL ROLE authenticated;
SELECT throws_ok(format('SELECT api.request_settings_change_v1(''label_provider'', ''tenant'', %L::uuid, %L::jsonb)', org, value),
  '22023', 'outbound_url_invalid', 'renderer settings request rejects a private HTTPS destination')
FROM renderer_url_payloads WHERE kind = 'private';
SELECT lives_ok(format('SELECT api.request_settings_change_v1(''label_provider'', ''tenant'', %L::uuid, %L::jsonb)', org, value),
  'renderer settings request accepts a public HTTPS destination')
FROM renderer_url_payloads WHERE kind = 'public';
SELECT set_config('app.local_label_renderer_url', value#>>'{providers,0,invoke_url}', true)
FROM renderer_url_payloads WHERE kind = 'unconfigured_local';
SELECT throws_ok(format('SELECT api.request_settings_change_v1(''label_provider'', ''tenant'', %L::uuid, %L::jsonb)', org, value),
  '22023', 'outbound_url_invalid', 'renderer settings request ignores a session-supplied local endpoint')
FROM renderer_url_payloads WHERE kind = 'unconfigured_local';
SELECT throws_ok(format('SELECT api.ui_apply_settings_value_v1(''label_provider'', ''tenant'', %L::uuid, %L::jsonb)', org, value),
  '22023', 'outbound_url_invalid', 'renderer direct settings apply rejects a private HTTPS destination')
FROM renderer_url_payloads WHERE kind = 'private';
SELECT lives_ok(format('SELECT api.ui_apply_settings_value_v1(''label_provider'', ''tenant'', %L::uuid, %L::jsonb)', org, value),
  'renderer direct settings apply accepts a public HTTPS destination')
FROM renderer_url_payloads WHERE kind = 'public';
RESET ROLE;

SELECT set_config('request.jwt.claims', '{"role":"service_role"}', true),
  set_config('request.jwt.claim.sub', '', true), set_config('request.jwt.claim.role', 'service_role', true);
SELECT is(public.invoke_label_renderer(1, jsonb_build_object('organization_id', org))->>'status',
  '202', 'renderer dispatch queues the public HTTPS destination saved by direct apply') FROM renderer_url_case;

SELECT ok(NOT public.label_renderer_url_allowed_v1(unconfigured_local_url),
  'local renderer policy rejects a different internal endpoint') FROM renderer_url_case;
SELECT public.upsert_label_provider_settings_v1('tenant', org, value, 'Local renderer URL fixture')
FROM renderer_url_payloads WHERE kind = 'local';
CREATE TEMP TABLE renderer_local_receipt AS
SELECT local_url, public.invoke_label_renderer(1, jsonb_build_object('organization_id', org)) AS receipt FROM renderer_url_case;
SELECT is(receipt->>'status', '202', 'configured local HTTP renderer enters the Edge queue') FROM renderer_local_receipt;
CREATE TEMP TABLE renderer_local_lease AS
SELECT r.local_url, c.job_id, c.lease_token FROM renderer_local_receipt r
CROSS JOIN LATERAL public.claim_edge_job_by_id_v1((r.receipt->>'edge_job_id')::uuid) c;
SELECT is(public.get_claimed_edge_job_call_spec_v1(job_id, lease_token)->>'url', local_url,
  'leased renderer spec accepts the exact database-configured local endpoint') FROM renderer_local_lease;
-- Simulate an active settings row written before the save guard existed.
SET CONSTRAINTS ALL IMMEDIATE;
ALTER TABLE public.settings DISABLE TRIGGER a00_label_provider_seal_cache;
UPDATE public.settings s SET cached_value = jsonb_set(s.cached_value, '{providers,0,invoke_url}', to_jsonb(f.rejected_url))
FROM renderer_url_case f WHERE s.category = 'label_provider' AND s.scope_type = 'tenant' AND s.scope_id = f.org;
ALTER TABLE public.settings ENABLE TRIGGER a00_label_provider_seal_cache;
SELECT is(public.invoke_label_renderer(1, jsonb_build_object('organization_id', org)) #>> '{body,reason}',
  'missing_or_invalid_url', 'renderer dispatch refuses previously stored private HTTPS') FROM renderer_url_case;
SELECT is(public.get_claimed_edge_job_call_spec_v1(job_id, lease_token), NULL::jsonb,
  'leased renderer spec refuses a previously stored private HTTPS replacement') FROM renderer_local_lease;

SELECT * FROM finish();
ROLLBACK;
