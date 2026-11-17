BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

SELECT plan(15);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM settings
    WHERE category = 'webhook_intake'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'webhook_intake global settings row exists'
);

SELECT has_column('operation_templates', 'call_type', 'operation_templates has call_type column');

SELECT is(
  resolve_settings('webhook_intake', 'global', NULL)->>'entry_template_id',
  '77770000-0000-0000-0000-000000770001',
  'webhook_intake global entry template defaults to webhook_intake_v1'
);

SELECT results_eq(
  $$
    SELECT (workflow_intake_webhook(NULL, '{}'::jsonb, '{}'::text, '{}'::jsonb)->>'status')::INT
  $$,
  ARRAY[401],
  'workflow_intake_webhook returns 401 when token missing'
);

SELECT ok(
  (resolve_webhook_intake_defaults(NULL::uuid)->>'accepted_async_status')::INT > 0,
  'resolve_webhook_intake_defaults supplies accepted_async_status'
);

SELECT ok(
  (resolve_webhook_intake_defaults(NULL::uuid)->>'poll_attempts')::INT >= 1,
  'resolve_webhook_intake_defaults supplies poll_attempts >= 1'
);

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
    COALESCE(sv.value, '{}'::jsonb)
    || jsonb_build_object(
      'defaults',
      jsonb_build_object(
        'accepted_async_status', 291,
        'synchronous_success_status', 208,
        'bad_request_status', 498,
        'error_status', 599,
        'poll_attempts', 3,
        'poll_interval_ms', 25
      )
    )
  )
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
      COALESCE(s.cached_value, '{}'::jsonb)
      || jsonb_build_object(
        'defaults',
        jsonb_build_object(
          'accepted_async_status', 291,
          'synchronous_success_status', 208,
          'bad_request_status', 498,
          'error_status', 599,
          'poll_attempts', 3,
          'poll_interval_ms', 25
        )
      )
    ),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

SELECT is(
  resolve_webhook_intake_defaults(NULL::uuid)->>'error_status',
  '599',
  'resolve_webhook_intake_defaults reflects overridden error_status'
);

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

DO $policy$
BEGIN
  PERFORM upsert_webhook_ingest_policy('source', source_id,
    '{"version":1,"ack":{"mode":"synchronous_success"},"validation":{"idempotency":{"header":"Idempotency-Key","body_path":"event.id"}}}'::jsonb)
  FROM tmp_owned_webhook;
END;
$policy$;

CREATE TEMP TABLE tmp_webhook_intake_entry_template AS
SELECT resolve_settings('webhook_intake', 'global', NULL)->>'entry_template_id' AS entry_template_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls((COALESCE(sv.value, '{}'::jsonb) - 'entry_template_id'))
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls((COALESCE(s.cached_value, '{}'::jsonb) - 'entry_template_id')),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

-- Fail at the fixture boundary if tenant materialization shadows this global fault.
DO $scope_check$
DECLARE
  v_effective JSONB;
BEGIN
  SELECT COALESCE(resolve_settings('webhook_intake','tenant',organization_id),
    resolve_settings('webhook_intake','global',NULL)) INTO STRICT v_effective
  FROM tmp_owned_webhook;
  IF NULLIF(v_effective->>'entry_template_id','') IS NOT NULL
     OR (v_effective#>>'{defaults,error_status}') IS DISTINCT FROM '599' THEN
    RAISE EXCEPTION 'Owned webhook tenant does not resolve the intended missing-template/error599 fixture';
  END IF;
END;
$scope_check$;

SELECT is(
  (
    SELECT (workflow_intake_webhook((SELECT token FROM tmp_owned_webhook), jsonb_build_object('Idempotency-Key',gen_random_uuid()::text), '{}'::text, '{}'::jsonb)->>'status')::INT
  ),
  599,
  'workflow_intake_webhook uses dynamic error_status when workflow template missing'
);

-- Configuration must not supersede source authentication or lose correlation.
SELECT is((workflow_intake_webhook(NULL,'{}','{}','{}')->>'status')::int,401,
 'Missing token stays unauthorized while template configuration is absent');
SELECT is((workflow_intake_webhook(gen_random_uuid()::text,'{}','{}','{}')->>'status')::int,401,
 'Unknown token cannot disclose missing template configuration');
UPDATE webhook_sources SET enabled=FALSE WHERE id=(SELECT source_id FROM tmp_owned_webhook);
SELECT is((workflow_intake_webhook((SELECT token FROM tmp_owned_webhook),'{}','{}','{}')->>'status')::int,401,
 'Disabled token cannot disclose missing template configuration');
UPDATE webhook_sources SET enabled=TRUE WHERE id=(SELECT source_id FROM tmp_owned_webhook);
SELECT is(workflow_intake_webhook((SELECT token FROM tmp_owned_webhook),jsonb_build_object('Idempotency-Key',gen_random_uuid()::text),'{}','{}')->>'response_reason',
 'missing_entry_template','Configured error identifies the missing template boundary');
SELECT ok(NULLIF(workflow_intake_webhook((SELECT token FROM tmp_owned_webhook),jsonb_build_object('Idempotency-Key',gen_random_uuid()::text),'{}','{}')->>'correlation_id','') IS NOT NULL,
 'Missing-template response retains canonical correlation');

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
orig AS (
  SELECT entry_template_id
  FROM tmp_webhook_intake_entry_template
  LIMIT 1
)
UPDATE settings_versions sv
SET value = jsonb_strip_nulls(
    (COALESCE(sv.value, '{}'::jsonb) - 'entry_template_id')
    || COALESCE(
        (
          SELECT CASE
                   WHEN entry_template_id IS NULL OR entry_template_id = ''
                     THEN NULL
                   ELSE jsonb_build_object('entry_template_id', entry_template_id)
                 END
          FROM orig
        ),
        '{}'::jsonb
      )
  )
FROM global_scope g
WHERE sv.id = g.settings_version_id;

WITH global_scope AS (
  SELECT s.settings_version_id, s.id AS settings_id
  FROM settings s
  WHERE s.category = 'webhook_intake'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
  LIMIT 1
),
orig AS (
  SELECT entry_template_id
  FROM tmp_webhook_intake_entry_template
  LIMIT 1
)
UPDATE settings s
SET cached_value = jsonb_strip_nulls(
      (COALESCE(s.cached_value, '{}'::jsonb) - 'entry_template_id')
      || COALESCE(
          (
            SELECT CASE
                     WHEN entry_template_id IS NULL OR entry_template_id = ''
                       THEN NULL
                     ELSE jsonb_build_object('entry_template_id', entry_template_id)
                   END
            FROM orig
          ),
          '{}'::jsonb
        )
    ),
    last_updated = now()
FROM global_scope g
WHERE s.id = g.settings_id;

DO $$
DECLARE
  v_source UUID;
BEGIN
  SELECT source_id INTO STRICT v_source FROM tmp_owned_webhook;
  PERFORM upsert_webhook_ingest_policy(
    'source',
    v_source,
    jsonb_build_object(
      'ack', jsonb_build_object(
        'mode', 'synchronous_success',
        'default_headers', jsonb_build_object('content-type', 'application/json')
      ),
      'validation', jsonb_build_object(
        'hmac', jsonb_build_object(
          'enabled', true,
          'header', 'x-signature'
        )
      ),
      'logging', jsonb_build_object('decision_point', 'workflow_intake_response')
    )
  );
END;
$$;

SELECT is(
  (
    SELECT (
      workflow_intake_webhook(
        (SELECT token FROM tmp_owned_webhook),
        jsonb_build_object('x-signature', 'invalid', 'Idempotency-Key', gen_random_uuid()::text),
        '{}'::text,
        '{}'::jsonb
      )->>'status'
    )::INT
  ),
  498,
  'Missing HMAC auth configuration returns dynamic bad_request_status'
);

SELECT is(workflow_intake_webhook((SELECT token FROM tmp_owned_webhook),
 jsonb_build_object('x-signature','invalid','Idempotency-Key',gen_random_uuid()::text),'{}','{}')->>'response_reason',
 'Missing auth_config reference for HMAC validation',
 'HMAC assertion reaches auth-config failure rather than an earlier idempotency failure');

SELECT * FROM finish();

ROLLBACK;
