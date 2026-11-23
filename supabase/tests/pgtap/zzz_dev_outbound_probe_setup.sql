BEGIN;

SELECT plan(5);

\set probe_marker dev-outbound-probe
SELECT gen_random_uuid()::text AS probe_run,
       concat('https://', repeat('a', 20), '.', 'supabase', '.', 'co', '/functions/v1') AS probe_base
\gset

INSERT INTO public.organizations (name, slug)
VALUES ('DEV outbound probe', :'probe_marker' || '-' || :'probe_run')
RETURNING id AS org_id
\gset
SELECT ok(:'org_id'::uuid IS NOT NULL, 'Probe organization was inserted');

INSERT INTO public.providers (organization_id, name, provider_type)
VALUES (:'org_id', :'probe_marker', 'http')
RETURNING id AS provider_id
\gset
SELECT ok(:'provider_id'::uuid IS NOT NULL, 'Probe HTTP provider was inserted');

INSERT INTO public.mapping_configs (organization_id, mapping_type, mapping_key, mapping_config)
VALUES (:'org_id', 'provider_response', :'probe_marker' || '-' || :'probe_run', '{}')
RETURNING id AS mapping_id
\gset
SELECT ok(:'mapping_id'::uuid IS NOT NULL, 'Probe response mapping was inserted');

INSERT INTO public.operation_templates (provider_id, operation_name, method, url_template, mapping_config_id, handler_key)
VALUES (:'provider_id', :'probe_marker', 'GET', :'probe_base' || '/outbound-probe-ack', :'mapping_id', 'outbound_http')
RETURNING id AS operation_id
\gset
SET CONSTRAINTS ALL IMMEDIATE;
SELECT ok(:'operation_id'::uuid IS NOT NULL, 'Probe operation template satisfies fixture constraints');

SELECT ok(public.enqueue_outbound_call_from_operation_template_v1(:'operation_id'::uuid, '{}'::jsonb,
  jsonb_build_object('probe_marker', :'probe_marker', 'probe_run', :'probe_run',
    'probe_lane', 'relay', 'organization_id', :'org_id'), NULL, p_max_retries => 1) IS NOT NULL,
  'Probe operation enqueues through the normal workflow guards');

SELECT * FROM finish();
ROLLBACK;
