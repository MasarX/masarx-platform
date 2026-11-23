BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, extensions, pgtap, pg_temp;
SELECT plan(111);

SELECT ok(NOT public.outbound_url_allowed_v1(url), 'rejects ' || kind)
FROM (VALUES
  ('missing URL', NULL::text),
  ('HTTP', 'http://example.test/path'),
  ('userinfo', 'https://fixture' || '@example.test/path'),
  ('private IPv4', 'https://' || concat_ws('.', 10, 0, 0, 1)),
  ('private IPv4 class B', 'https://' || concat_ws('.', 172, 16, 0, 1)),
  ('private IPv4 class C', 'https://' || concat_ws('.', 192, 168, 0, 1)),
  ('IPv4 loopback', 'https://' || concat_ws('.', 127, 0, 0, 1)),
  ('IPv4 link-local', 'https://' || concat_ws('.', 169, 254, 1, 1)),
  ('IPv4 metadata', 'https://' || concat_ws('.', 169, 254, 169, 254)),
  ('IPv4 shared address space', 'https://' || concat_ws('.', 100, 64, 0, 1)),
  ('IPv4 unspecified', 'https://' || concat_ws('.', 0, 0, 0, 0)),
  ('IPv4 multicast', 'https://' || concat_ws('.', 224, 0, 0, 1)),
  ('short IPv4', 'https://' || concat_ws('.', 127, 1)),
  ('numeric host', 'https://' || (127::bigint * 16777216 + 1)::text),
  ('mixed-base numeric host', 'https://' || '0x' || to_hex(127) || '.1'),
  ('IPv4-mapped IPv6 with dotted tail', format('https://[::ffff:%s]', concat_ws('.', 127, 0, 0, 1))),
  ('IPv4-mapped IPv6 with hex tail', format('https://[::ffff:%s:%s]', to_hex(10 * 256), to_hex(1))),
  ('IPv6 unspecified', 'https://[' || ':' || ':]'),
  ('IPv6 loopback', 'https://[' || ':' || ':1]'),
  ('IPv6 private', 'https://[' || 'fc00' || '::1]'),
  ('IPv6 metadata', 'https://[' || 'fd00:' || 'ec2::254]'),
  ('IPv6 multicast', 'https://[' || 'ff02' || '::1]'),
  ('IPv6 link-local', 'https://[' || 'fe80' || '::1]'),
  ('loopback hostname', 'https://' || 'local' || 'host'),
  ('local domain', 'https://fixture.' || 'local'),
  ('internal domain', 'https://fixture.' || 'internal'),
  ('home network suffix', 'https://fixture.' || 'home' || '.arpa'),
  ('punycode label inside hostname', 'https://fixture.XN--bcher-kva.example.test'),
  ('absolute loopback hostname suffix', 'https://FIXTURE.' || upper('local' || 'host') || '.'),
  ('escaped authority', 'https://fixture%2eexample.test'),
  ('authority template', 'https://{{host}}/path'),
  ('backslash', 'https://example.test' || chr(92) || 'path'),
  ('invalid port', 'https://example.test' || ':65536')
) AS cases(kind, url);

SELECT ok(public.outbound_url_allowed_v1(url), 'accepts ' || kind)
FROM (VALUES
  ('public HTTPS DNS name', 'HTTPS://example.com.' || ':443/path?source=fixture'),
  ('HTTPS template with a static host', 'https://example.com/{{path}}'),
  ('public IPv4 literal', 'https://' || concat_ws('.', 8, 8, 8, 8)),
  ('public IPv6 literal', 'https://[' || '2606:4700:' || ':1111]:443'),
  ('mapped public IPv4 literal', format('https://[::ffff:%s]', concat_ws('.', 8, 8, 8, 8)))
) AS cases(kind, url);

SELECT ok(NOT public.outbound_url_allowed_v1(
  'http://' || concat_ws('.', 127, 0, 0, 1), jsonb_build_array(concat_ws('.', 127, 0, 0, 1))),
  'a listed IP literal cannot use HTTP');
SELECT ok(NOT public.outbound_url_allowed_v1(
  'http://fixture.' || 'local', jsonb_build_array('fixture.' || 'local')),
  'a listed local hostname cannot use HTTP');

SELECT is(
  public.outbound_dispatch_headers_v1('https://example.com',
    jsonb_build_object('Accept', 'application/json', 'D360-API-KEY', 'fixture',
      'HOST', 'fixture', 'Cookie', 'fixture', 'Proxy-Authorization', 'fixture',
      'X-Unlisted', 'fixture', 'X-Request-Id', 'fixture' || chr(13) || chr(10) || 'continued')),
  '{"Accept":"application/json","D360-API-KEY":"fixture"}'::jsonb,
  'dispatch keeps allowed headers and drops denied names and invalid values'
);
SELECT throws_ok(
  $$SELECT public.outbound_dispatch_headers_v1('http://example.test/path', '{}'::jsonb)$$,
  '22023', 'outbound_url_invalid', 'dispatch rejects an invalid rendered URL'
);

SELECT ok(NOT has_function_privilege(role_name, signature, 'EXECUTE'),
  role_name || ' cannot execute ' || signature)
FROM unnest(ARRAY['anon','authenticated','service_role','ui_rpc_executor']) AS roles(role_name)
CROSS JOIN unnest(ARRAY[
  'public.outbound_url_allowed_v1(text,jsonb)',
  'public.outbound_placeholder_url_v1(text)',
  'public.outbound_dns_hostname_v1(text)',
  'public.outbound_http_allowed_hosts_v1(uuid)',
  'public.outbound_job_http_allowed_hosts_v1(uuid)',
  'public.validate_outbound_http_hosts_write_v1()',
  'public.mark_outbound_url_invalid_v1(uuid,text)',
  'public.filter_outbound_headers_v1(jsonb)',
  'public.validate_outbound_integration_write_v1()',
  'public.outbound_dispatch_headers_v1(text,jsonb,uuid)'
]) AS functions(signature);

SELECT public.create_next_partitions();

CREATE TEMP TABLE outbound_validation_ids AS
SELECT gen_random_uuid() AS org, gen_random_uuid() AS actor, gen_random_uuid() AS provider,
       gen_random_uuid() AS operation, gen_random_uuid() AS mapping, gen_random_uuid() AS run,
       gen_random_uuid() AS run_step, gen_random_uuid() AS template, gen_random_uuid() AS template_step,
       gen_random_uuid() AS plugin, gen_random_uuid() AS version,
       gen_random_uuid() AS bad_edge_job, gen_random_uuid() AS good_edge_job,
       gen_random_uuid() AS bad_batch_job, gen_random_uuid() AS good_batch_job,
       gen_random_uuid() AS bad_inline_job,
       'url-validation-' || gen_random_uuid() AS workflow;
GRANT SELECT ON outbound_validation_ids TO authenticated;

INSERT INTO public.organizations (id, name, slug, billing_status)
SELECT org, 'Outbound validation fixture', 'url-validation-' || org, 'active'
FROM outbound_validation_ids;
INSERT INTO public.users (id, organization_id, email, full_name, user_type, status, access_scope_type)
SELECT actor, org, 'url-validation-' || actor || '@example.test', 'Outbound validation actor',
       'ops_admin', 'active', 'tenant'
FROM outbound_validation_ids;

DO $policy$
DECLARE
  v_policy jsonb;
  v_version integer;
BEGIN
  SELECT v.value, v.schema_version INTO STRICT v_policy, v_version
  FROM public.settings s
  JOIN public.settings_versions v ON v.id = s.settings_version_id
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = public.get_root_scope_type_key_v1() AND s.scope_id IS NULL;

  SELECT jsonb_set(v_policy, '{roles}', jsonb_agg(
    CASE WHEN role->>'key' = 'ops_admin'
      THEN jsonb_set(role, '{capability_keys}', '["system.write","integration_plugins.activate","integration_plugins.write"]')
      ELSE role END ORDER BY ordinal))
  INTO v_policy FROM jsonb_array_elements(v_policy->'roles') WITH ORDINALITY AS roles(role, ordinal);

  PERFORM public.upsert_settings_value_v1('access_control_policy', 'tenant', org,
    v_policy, v_version, 'Outbound validation fixture policy')
  FROM pg_temp.outbound_validation_ids;
END;
$policy$;

SELECT public.upsert_settings_value_v1(
  'integration_plugin_egress_policy', 'tenant', org,
  jsonb_build_object(
    'version', 1, 'enforce_https_only', true, 'block_private_networks', true,
    'http_allowed_hosts', jsonb_build_array('approved.example.test'),
    'allowed_methods', jsonb_build_array('GET', 'POST', 'PUT', 'PATCH', 'DELETE'),
    'max_payload_bytes', 262144, 'max_timeout_seconds', 60, 'follow_redirects', false,
    'header_allowlist', jsonb_build_array('accept', 'content-type', 'authorization', 'x-api-key', 'user-agent')
  ), 1, 'Outbound URL validation policy fixture')
FROM outbound_validation_ids;

SELECT throws_ok(
  $sql$UPDATE public.settings
       SET cached_value = cached_value || '{"http_allowed_hosts":["*.example.test"]}'::jsonb
       WHERE category = 'integration_plugin_egress_policy' AND scope_type = 'tenant'
         AND scope_id = (SELECT org FROM outbound_validation_ids)$sql$,
  '22023', 'outbound_http_allowed_hosts_invalid', 'active policy writes reject wildcard hosts'
);
SELECT throws_ok(
  $sql$UPDATE public.settings_versions
       SET value = jsonb_set(value, '{http_allowed_hosts}', jsonb_build_array(concat_ws('.', 8, 8, 8, 8)))
       WHERE category = 'integration_plugin_egress_policy' AND scope_type = 'tenant'
         AND scope_id = (SELECT org FROM outbound_validation_ids)$sql$,
  '22023', 'outbound_http_allowed_hosts_invalid', 'policy version writes reject IP literals'
);
SELECT throws_ok(
  format($sql$UPDATE public.settings
       SET cached_value = jsonb_set(cached_value, '{http_allowed_hosts}', jsonb_build_array(%L::text))
       WHERE category = 'integration_plugin_egress_policy' AND scope_type = 'tenant'
         AND scope_id = (SELECT org FROM outbound_validation_ids)$sql$, host),
  '22023', 'outbound_http_allowed_hosts_invalid', 'policy writes reject ' || kind
)
FROM (VALUES
  ('internal names', 'fixture.' || 'internal'),
  ('the home network domain', 'home' || '.arpa'),
  ('punycode labels inside hostnames', 'fixture.XN--bcher-kva.example.test')
) AS cases(kind, host);

INSERT INTO public.providers (id, organization_id, name, provider_type)
SELECT provider, org, 'Outbound validation provider', 'http' FROM outbound_validation_ids;

INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config)
SELECT mapping, org, 'provider_response', 'outbound-validation-' || mapping, '{}' FROM outbound_validation_ids;

INSERT INTO public.operation_templates
  (id, provider_id, operation_name, method, url_template, headers_template, handler_key, handler_version, call_type, mapping_config_id)
SELECT operation, provider, 'outbound_validation', 'POST', 'https://example.test/before',
       '{"content-type":"application/json"}', 'outbound_http', 'v1', 'provider_api', mapping
FROM outbound_validation_ids;

SELECT set_config('app.workflow_run_id', run::text, true),
       set_config('app.workflow_run_step_id', run_step::text, true),
       set_config('masarx.workflow_run_step_id', run_step::text, true),
       set_config('masarx.workflow_engine', '1', true)
FROM outbound_validation_ids;

INSERT INTO public.workflow_templates (id, name, version, status, scope_type, scope_id)
SELECT template, workflow, 1, 'active', 'tenant', org FROM outbound_validation_ids;
INSERT INTO public.workflow_template_steps
  (id, workflow_template_id, sequence_order, operation_name, transition_condition, handler_key, handler_version)
SELECT template_step, template, 1, 'outbound_http', 'always', 'outbound_http', 'v1' FROM outbound_validation_ids;
INSERT INTO public.workflow_runs
  (id, workflow_template_id, workflow_template_version, entry_point, workflow_status, context)
SELECT run, template, 1, 'test', 'pending', jsonb_build_object('organization_id', org) FROM outbound_validation_ids;
INSERT INTO public.workflow_run_steps
  (id, workflow_run_id, workflow_template_step_id, sequence_order, step_status, operation_name, handler_key, handler_version, max_retries)
SELECT run_step, run, template_step, 1, 'pending', 'outbound_http', 'outbound_http', 'v1', 1 FROM outbound_validation_ids;

SELECT throws_ok(
  $$INSERT INTO public.outbound_calls(call_type, target_type, target_id, method, url)
    SELECT 'provider_api', 'provider', provider, 'POST', 'http://example.test/path'
    FROM outbound_validation_ids$$,
  '22023', 'outbound_url_invalid', 'queue inserts reject unlisted HTTP URLs'
);
SELECT throws_ok(
  $$INSERT INTO public.outbound_calls(call_type, target_type, target_id, method, url)
    SELECT 'provider_api', 'provider', provider, 'POST', 'ftp://example.test/path'
    FROM outbound_validation_ids$$,
  '22023', 'outbound_url_invalid', 'queue rejects unrecognized schemes'
);
SELECT throws_ok(
  $$UPDATE public.operation_templates SET url_template = 'workflow://example.test/operation'
    WHERE id = (SELECT operation FROM outbound_validation_ids)$$,
  '22023', 'outbound_url_invalid', 'templates reject non-internal workflow URLs'
);
SELECT lives_ok(
  $$UPDATE public.operation_templates SET url_template = 'workflow://internal/outbound_validation'
    WHERE id = (SELECT operation FROM outbound_validation_ids)$$,
  'the internal workflow catalog URL can be saved'
);
SELECT lives_ok(
  $$UPDATE public.operation_templates SET url_template = 'http://approved.example.test/template'
    WHERE id = (SELECT operation FROM outbound_validation_ids)$$,
  'the listed HTTP hostname can be saved in a template with HTTPS as the default'
);
SELECT lives_ok(
  $$INSERT INTO public.outbound_calls(call_type, target_type, target_id, method, url, status)
    SELECT 'provider_api', 'provider', provider, 'POST', placeholder, 'completed'
    FROM outbound_validation_ids
    CROSS JOIN (VALUES ('comms://sms'), ('geocode://provider'), ('workflow://internal/outbound_validation')) t(placeholder)$$,
  'comms, geocode and internal workflow placeholders can be saved'
);

INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, status, scheduled_at, context)
SELECT job, 'provider_api', 'provider', provider, 'POST', stored_url, 'pending_edge', now(),
       jsonb_build_object('organization_id', org, 'edge_dispatch',
         jsonb_build_object('url', url, 'headers', '{"accept":"application/json","host":"fixture"}'::jsonb))
FROM outbound_validation_ids
CROSS JOIN LATERAL (VALUES
  (bad_edge_job, 'comms://sms', 'comms://sms'),
  (good_edge_job, 'http://approved.example.test/queued', 'http://approved.example.test/edge')
) AS edge(job, stored_url, url);

SELECT throws_ok(
  $$UPDATE public.outbound_calls SET url = 'http://example.test/path'
    WHERE id = (SELECT good_edge_job FROM outbound_validation_ids)$$,
  '22023', 'outbound_url_invalid', 'queue updates validate stored URLs'
);

SELECT is(public.get_claimed_edge_job_call_spec_v1(claim.job_id, claim.lease_token), NULL::jsonb,
          'the Edge claim refuses a saved placeholder as a rendered URL')
FROM outbound_validation_ids ids
CROSS JOIN LATERAL public.claim_edge_job_by_id_v1(ids.bad_edge_job) AS claim;
SELECT is(oc.error_message, 'outbound_url_invalid', 'Edge records the stable rejection code')
FROM public.outbound_calls oc JOIN outbound_validation_ids ids ON oc.id = ids.bad_edge_job;
CREATE TEMP TABLE outbound_validation_edge_spec AS
SELECT public.get_claimed_edge_job_call_spec_v1(claim.job_id, claim.lease_token) AS spec
FROM outbound_validation_ids ids
CROSS JOIN LATERAL public.claim_edge_job_by_id_v1(ids.good_edge_job) AS claim;
SELECT is(spec->'headers', '{"accept":"application/json"}'::jsonb, 'Edge drops a disallowed header')
FROM outbound_validation_edge_spec;
SELECT is(spec->>'url', 'http://approved.example.test/edge', 'Edge accepts the exact listed HTTP hostname')
FROM outbound_validation_edge_spec;
SELECT is(spec->>'http_allowed_host', 'approved.example.test', 'Edge gets only the approved hostname')
FROM outbound_validation_edge_spec;

INSERT INTO public.outbound_calls (id, call_type, target_type, target_id, method, url, status, priority, context)
SELECT job, 'provider_api', 'provider', provider, 'POST', url, 'pending', priority,
       jsonb_build_object('organization_id', org)
FROM outbound_validation_ids
CROSS JOIN LATERAL (VALUES
  (bad_batch_job, 'comms://sms', 100),
  (good_batch_job, 'https://example.test/batch', 90),
  (bad_inline_job, 'geocode://provider', 80)
) AS batch(job, url, priority);

UPDATE public.outbound_calls SET scheduled_at = now() + interval '100 years'
WHERE id NOT IN (SELECT bad_batch_job FROM outbound_validation_ids UNION ALL SELECT good_batch_job FROM outbound_validation_ids)
  AND status IN ('pending', 'pending_edge', 'failed') AND scheduled_at <= now();
CREATE TEMP TABLE outbound_validation_net_baseline AS SELECT count(*) AS total FROM net.http_request_queue;

SELECT set_config('app.force_worker', 'outbound_worker', true);
CREATE TEMP TABLE outbound_validation_worker_result AS SELECT public.run_outbound_worker() AS result;
SELECT ok(result->>'status' = 'completed' AND result->>'items_processed' = '1'
  AND EXISTS (SELECT FROM public.outbound_calls o WHERE o.id = ids.good_batch_job
    AND o.status = 'pending_edge' AND o.edge_lease_token IS NULL AND o.context ? 'edge_dispatch')
  AND EXISTS (SELECT FROM public.outbound_calls o WHERE o.id = ids.bad_batch_job
    AND o.status = 'permanently_failed' AND NOT (o.context ? 'edge_dispatch') AND o.lease_expires_at IS NULL),
  'worker hands off exactly the rendered request and settles the placeholder before a generic claim')
FROM outbound_validation_worker_result CROSS JOIN outbound_validation_ids;
SELECT is(oc.status, 'permanently_failed', 'the placeholder failure is terminal')
FROM public.outbound_calls oc JOIN outbound_validation_ids ids ON oc.id = ids.bad_batch_job;
SELECT is(oc.error_message, 'outbound_url_invalid', 'the worker records the stable invalid-URL code')
FROM public.outbound_calls oc JOIN outbound_validation_ids ids ON oc.id = ids.bad_batch_job;
CREATE TEMP TABLE outbound_validation_batch_claim AS SELECT * FROM public.claim_pending_edge_job_ids_v1(1);
SELECT ok(
  (SELECT array_agg(job_id) FROM outbound_validation_batch_claim WHERE lease_token IS NOT NULL) = ARRAY[ids.good_batch_job]
  AND EXISTS (SELECT FROM outbound_validation_batch_claim l
    WHERE public.get_claimed_edge_job_call_spec_v1(l.job_id, l.lease_token)->>'url'
          = (SELECT url FROM public.outbound_calls WHERE id = ids.good_batch_job))
  AND (SELECT count(*) FROM net.http_request_queue) = (SELECT total FROM outbound_validation_net_baseline),
  'only the valid job has a lease and neither worker job creates a pg_net row')
FROM outbound_validation_ids ids;
UPDATE public.outbound_calls o SET scheduled_at = now()
FROM outbound_validation_ids ids WHERE o.id = ids.bad_inline_job;
SELECT is(public.dispatch_outbound_call_inline(bad_inline_job,
    '{"timeout_seconds":1,"poll_max_seconds":0,"poll_interval_ms":50,"pending_reschedule_seconds":60,"lease_seconds":60}') ->> 'reason',
  'outbound_url_invalid', 'inline dispatch returns the stable rejection without raising')
FROM outbound_validation_ids;
SELECT is(oc.status, 'permanently_failed', 'the inline rejection is terminal')
FROM public.outbound_calls oc JOIN outbound_validation_ids ids ON oc.id = ids.bad_inline_job;

INSERT INTO public.integration_plugins (id, organization_id, plugin_key, name, plugin_kind)
SELECT plugin, org, 'url-validation-' || plugin, 'Outbound validation plugin', 'api'
FROM outbound_validation_ids;
INSERT INTO public.integration_plugin_versions
  (id, plugin_id, organization_id, version_no, status, inbound_config, workflow_binding, outbound_operations)
SELECT version, plugin, org, 1, 'approved',
       jsonb_build_object('route', jsonb_build_object('method', 'POST', 'path_template', '/' || workflow,
         'upstream_base_url', 'https://example.test')),
       jsonb_build_object('template_name', workflow),
       '[{"operation_name":"outbound_validation","url_template":"http://example.test/plugin"}]'
FROM outbound_validation_ids;

CREATE FUNCTION pg_temp.save_outbound_validation_template(p_request jsonb)
RETURNS jsonb LANGUAGE sql AS $function$
  SELECT api.ui_upsert_mapping_artifact_v1(jsonb_build_object(
    'artifact', 'api_outbound', 'organization_id', org,
    'operation_template_id', operation, 'request_config', p_request
  ))
  FROM outbound_validation_ids;
$function$;

SELECT set_config('request.jwt.claims', jsonb_build_object('sub', actor, 'role', 'authenticated')::text, true),
       set_config('request.jwt.claim.sub', actor::text, true),
       set_config('request.jwt.claim.role', 'authenticated', true)
FROM outbound_validation_ids;

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT pg_temp.save_outbound_validation_template('{"url_template":"http://example.test/mapping"}')$$,
  '22023', 'outbound_url_invalid', 'Mapping Studio rejects an invalid URL'
);
SELECT throws_ok(
  $$SELECT pg_temp.save_outbound_validation_template('{"headers_template":{"X-Unlisted":"fixture"}}')$$,
  '22023', 'outbound_headers_invalid', 'Mapping Studio rejects a disallowed header'
);
SELECT lives_ok(
  $$SELECT pg_temp.save_outbound_validation_template('{"url_template":"https://example.test/mapping","headers_template":{"X-Request-Id":"fixture"}}')$$,
  'Mapping Studio saves a valid URL and header'
);
SELECT throws_ok(
  $$SELECT api.integration_plugin_activate_v1(version, 'tenant', org) FROM outbound_validation_ids$$,
  '22023', 'outbound_url_invalid', 'activation rejects an invalid approved operation URL'
);

RESET ROLE;
UPDATE public.integration_plugin_versions pv SET outbound_operations =
  '[{"operation_name":"outbound_validation","url_template":"https://example.test/plugin","headers_template":{"host":"fixture"}}]'
FROM outbound_validation_ids ids WHERE pv.id = ids.version;

SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$SELECT api.integration_plugin_activate_v1(version, 'tenant', org) FROM outbound_validation_ids$$,
  '22023', 'outbound_headers_invalid', 'activation rejects an unapproved header'
);

RESET ROLE;
UPDATE public.integration_plugin_versions pv SET outbound_operations =
  '[{"operation_name":"outbound_validation","url_template":"https://example.test/plugin","headers_template":{"accept":"application/json"}}]'
FROM outbound_validation_ids ids WHERE pv.id = ids.version;

SET LOCAL ROLE authenticated;
SELECT is(api.integration_plugin_activate_v1(version, 'tenant', org)->>'ok', 'true',
          'activation materializes a valid outbound template')
FROM outbound_validation_ids;
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
