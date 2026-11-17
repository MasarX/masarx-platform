-- Test Suite: Webhook ingest policy ladder precedence

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

CREATE TEMP TABLE tmp_policy_receipts (scope_type TEXT PRIMARY KEY, settings_id UUID);

CREATE TEMP TABLE tmp_owned_webhook (source_id UUID, organization_id UUID, sender_id UUID, token TEXT);
DO $fixture$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_sender UUID := gen_random_uuid();
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_token TEXT := 'pgtap-owned-' || gen_random_uuid()::text;
  v_provider TEXT;
BEGIN
  -- Keep this test deterministic: disable onboarding side effects that now
  -- auto-materialize required defaults at tenant/client/sender scopes.
  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope_type,
    NULL,
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'ensure_global_required_defaults', FALSE,
      'materialize_defaults', jsonb_build_object(
        'tenant', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        ),
        'client', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        ),
        'sender', jsonb_build_object(
          'use_registry_required_defaults', FALSE,
          'strict_required_coverage', FALSE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array()
        )
      ),
      'rbac', jsonb_build_object(
        'provision_templates', FALSE,
        'template_keys', jsonb_build_array()
      ),
      'client_defaults', jsonb_build_object(
        'create_default_sender', FALSE,
        'default_sender_name', 'Default Sender',
        'default_sender_brand_name', NULL
      )
    ),
    1,
    'pgTAP policy ladder test isolation: disable onboarding auto-bootstrap side effects'
  );


  SELECT lv.value INTO STRICT v_provider
  FROM public.lookup_definitions ld JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'integration_type' AND COALESCE(lv.status, 'active') = 'active'
  ORDER BY COALESCE(lv.sort_order, 2147483647), lv.value LIMIT 1;
  INSERT INTO public.organizations(id,name,slug,timezone,locale,billing_status,default_settings)
  VALUES(v_org,'pgTAP Owned Webhook','pgtap-' || v_org::text,'Asia/Riyadh','en-US','active','{}');
  INSERT INTO public.clients(id,organization_id,name,slug,sla_tier,status,settings_override)
  VALUES(v_client,v_org,'pgTAP Client','pgtap-' || v_client::text,'standard','active','{}');
  INSERT INTO public.senders(id,client_id,name,brand_name,auto_provisioned,auto_recreate,status,settings_override)
  VALUES(v_sender,v_client,'pgTAP Sender','pgTAP',FALSE,TRUE,'active','{}');
  INSERT INTO public.mapping_configs(id,organization_id,mapping_type,mapping_key,mapping_config,mapping_version,notes)
  VALUES(v_mapping,v_org,'webhook_inbound','pgtap-' || v_mapping::text,
    '{"external_id_path":"event.id","event_type_path":"event.type"}',1,'Owned rollback-only fixture');
  INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,mapping_config_id,enabled,sender_id,rate_limit_per_hour)
  VALUES(v_source,v_org,'pgtap-' || v_source::text,'pgTAP Source',v_provider,v_token,v_mapping,TRUE,v_sender,1000);
  INSERT INTO tmp_owned_webhook VALUES(v_source,v_org,v_sender,v_token);
END;
$fixture$;

-- Tenant override: synchronous_success (200)
INSERT INTO tmp_policy_receipts(scope_type, settings_id)
SELECT 'tenant', upsert_webhook_ingest_policy('tenant', (SELECT organization_id FROM tmp_owned_webhook), jsonb_build_object(
  'version', 1,
  'ack', jsonb_build_object('mode','synchronous_success','status_code',200)
));
SELECT ok(
  (SELECT settings_id IS NOT NULL FROM tmp_policy_receipts WHERE scope_type = 'tenant'),
  'Seeded tenant synchronous_success policy'
);

-- Sender override: synchronous_success (200)
INSERT INTO tmp_policy_receipts(scope_type, settings_id)
SELECT 'sender', upsert_webhook_ingest_policy('sender', (SELECT sender_id FROM tmp_owned_webhook), jsonb_build_object(
  'version', 1,
  'ack', jsonb_build_object('mode','synchronous_success','status_code',200)
));
SELECT ok(
  (SELECT settings_id IS NOT NULL FROM tmp_policy_receipts WHERE scope_type = 'sender'),
  'Seeded sender synchronous_success policy'
);

-- Source override: accepted_async (202)
INSERT INTO tmp_policy_receipts(scope_type, settings_id)
SELECT 'source', upsert_webhook_ingest_policy('source', (SELECT source_id FROM tmp_owned_webhook), jsonb_build_object(
  'version', 1,
  'ack', jsonb_build_object('mode','accepted_async','status_code',202)
));
SELECT ok(
  (SELECT settings_id IS NOT NULL FROM tmp_policy_receipts WHERE scope_type = 'source'),
  'Seeded source accepted_async policy'
);

-- Expect resolution to select the most specific scope (source)
SELECT is(
  (
    SELECT scope_type FROM resolve_webhook_ingest_policy((SELECT source_id FROM tmp_owned_webhook))
  ),
  'source',
  'resolve_webhook_ingest_policy selects source scope when present'
);


-- Independently read persisted identities and their current approved version.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM tmp_policy_receipts r
    JOIN public.settings s ON s.id = r.settings_id
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN tmp_owned_webhook owned
    WHERE r.scope_type = 'tenant'
      AND s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'tenant'
      AND s.scope_id = owned.organization_id
      AND sv.category = s.category
      AND sv.scope_type = s.scope_type
      AND sv.scope_id = s.scope_id
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
      AND sv.value = s.cached_value
      AND s.cached_value #>> '{ack,mode}' = 'synchronous_success'
      AND (s.cached_value #>> '{ack,status_code}')::integer = 200
  ),
  'tenant upsert persists the owned policy identity, current version and expected ACK'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM tmp_policy_receipts r
    JOIN public.settings s ON s.id = r.settings_id
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN tmp_owned_webhook owned
    WHERE r.scope_type = 'sender'
      AND s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'sender'
      AND s.scope_id = owned.sender_id
      AND sv.category = s.category
      AND sv.scope_type = s.scope_type
      AND sv.scope_id = s.scope_id
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
      AND sv.value = s.cached_value
      AND s.cached_value #>> '{ack,mode}' = 'synchronous_success'
      AND (s.cached_value #>> '{ack,status_code}')::integer = 200
  ),
  'sender upsert persists the owned policy identity, current version and expected ACK'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM tmp_policy_receipts r
    JOIN public.settings s ON s.id = r.settings_id
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    CROSS JOIN tmp_owned_webhook owned
    WHERE r.scope_type = 'source'
      AND s.category = 'webhook_ingest_policy'
      AND s.scope_type = 'source'
      AND s.scope_id = owned.source_id
      AND sv.category = s.category
      AND sv.scope_type = s.scope_type
      AND sv.scope_id = s.scope_id
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
      AND sv.value = s.cached_value
      AND s.cached_value #>> '{ack,mode}' = 'accepted_async'
      AND (s.cached_value #>> '{ack,status_code}')::integer = 202
  ),
  'source upsert persists the owned policy identity, current version and expected ACK'
);

SELECT * FROM finish();

ROLLBACK;
