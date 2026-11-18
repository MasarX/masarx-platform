-- pgTAP: Console V2 webhook routing-rule write actions deny lower-permission
-- users before mutating rule state or writing lifecycle/audit side effects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(18);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d751';
  v_ops UUID := '00000000-0000-0000-0000-00000000d752';
  v_limited UUID := '00000000-0000-0000-0000-00000000d753';
  v_mapping UUID := '00000000-0000-0000-0000-00000000d754';
  v_source UUID := '00000000-0000-0000-0000-00000000d755';
  v_rule UUID := '00000000-0000-0000-0000-00000000d756';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Webhook Rule Denied Org', 'console-v2-webhook-rule-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'webhook-rule-denied-ops@example.com', 'Webhook Rule Denied Ops', 'ops_admin', 'tenant', NULL),
    (v_limited, v_org, 'webhook-rule-denied-limited@example.com', 'Webhook Rule Denied Limited', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, organization_id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-webhook-rule-denied',
    '{}'::jsonb,
    1,
    'Console V2 webhook rule denied-state pgTAP mapping'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config = EXCLUDED.mapping_config;

  INSERT INTO public.webhook_sources (
    id,
    organization_id,
    source_identifier,
    name,
    provider_type,
    auth_token,
    mapping_config_id,
    enabled
  )
  VALUES (
    v_source,
    v_org,
    'console-v2-webhook-rule-denied-source',
    'Console V2 Webhook Rule Denied Source',
    'generic',
    'console-v2-webhook-rule-denied-token',
    v_mapping,
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_config_id = EXCLUDED.mapping_config_id,
         enabled = TRUE;

  INSERT INTO public.webhook_rules (
    id,
    webhook_source_id,
    event_type,
    name,
    priority,
    mapping_config_id,
    domain_category,
    enabled
  )
  VALUES (
    v_rule,
    v_source,
    'shipment.created',
    'Console V2 Webhook Rule Denied Rule',
    120,
    v_mapping,
    'shipment',
    TRUE
  )
  ON CONFLICT (id) DO UPDATE
     SET webhook_source_id = EXCLUDED.webhook_source_id,
         event_type = EXCLUDED.event_type,
         name = EXCLUDED.name,
         priority = EXCLUDED.priority,
         mapping_config_id = EXCLUDED.mapping_config_id,
         domain_category = EXCLUDED.domain_category,
         enabled = EXCLUDED.enabled;

  PERFORM set_config('test.webhook_rule_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.webhook_rule_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.webhook_rule_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.webhook_rule_denied_mapping', v_mapping::TEXT, TRUE);
  PERFORM set_config('test.webhook_rule_denied_source', v_source::TEXT, TRUE);
  PERFORM set_config('test.webhook_rule_denied_rule', v_rule::TEXT, TRUE);
  PERFORM set_config(
    'test.webhook_rule_denied_count',
    (SELECT COUNT(*)::TEXT FROM public.webhook_rules WHERE webhook_source_id = v_source),
    TRUE
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.ui_upsert_webhook_rule_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_upsert_webhook_rule_v1(jsonb)', 'EXECUTE'),
  'api.ui_upsert_webhook_rule_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_delete_webhook_rule_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_delete_webhook_rule_v1(jsonb)', 'EXECUTE'),
  'api.ui_delete_webhook_rule_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_reorder_webhook_rule_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_reorder_webhook_rule_v1(jsonb)', 'EXECUTE'),
  'api.ui_reorder_webhook_rule_v1 wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_webhook_rule_v1(jsonb_build_object(
       'webhook_source_id', current_setting('test.webhook_rule_denied_source'),
       'event_type', 'shipment.updated',
       'name', 'Denied public rule create',
       'priority', 90,
       'mapping_config_id', current_setting('test.webhook_rule_denied_mapping'),
       'domain_category', 'shipment'
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_webhook_rule_v1 create'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_webhook_rule_v1(jsonb_build_object(
       'webhook_source_id', current_setting('test.webhook_rule_denied_source'),
       'event_type', 'shipment.canceled',
       'name', 'Denied api rule create',
       'priority', 80,
       'mapping_config_id', current_setting('test.webhook_rule_denied_mapping'),
       'domain_category', 'shipment'
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_upsert_webhook_rule_v1 create'
);
RESET ROLE;

SELECT is(
  (
    SELECT COUNT(*)::TEXT
      FROM public.webhook_rules
     WHERE webhook_source_id = current_setting('test.webhook_rule_denied_source')::UUID
  ),
  current_setting('test.webhook_rule_denied_count'),
  'denied rule create attempts write no webhook_rules rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule'),
       'name', 'Denied public rule update',
       'priority', 77,
       'enabled', false
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_webhook_rule_v1 update'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule'),
       'name', 'Denied api rule update',
       'priority', 66,
       'enabled', false
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_upsert_webhook_rule_v1 update'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_rules
     WHERE id = current_setting('test.webhook_rule_denied_rule')::UUID
       AND event_type = 'shipment.created'
       AND name = 'Console V2 Webhook Rule Denied Rule'
       AND priority = 120
       AND enabled IS TRUE
  ),
  'denied rule update attempts leave name, event, priority, and enabled state unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_reorder_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule'),
       'priority', 321
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_reorder_webhook_rule_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_reorder_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule'),
       'priority', 654
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_reorder_webhook_rule_v1'
);
RESET ROLE;

SELECT is(
  (
    SELECT priority::TEXT
      FROM public.webhook_rules
     WHERE id = current_setting('test.webhook_rule_denied_rule')::UUID
  ),
  '120',
  'denied reorder attempts leave webhook rule priority unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_delete_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule')
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_delete_webhook_rule_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_delete_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.webhook_rule_denied_rule')
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_delete_webhook_rule_v1'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_rules
     WHERE id = current_setting('test.webhook_rule_denied_rule')::UUID
  ),
  'denied delete attempts leave webhook rule row present'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE resource_id = current_setting('test.webhook_rule_denied_rule')::UUID
       AND event_type LIKE 'webhook_rule.%'
  ),
  'denied rule write attempts write no webhook_rule domain events'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE decision_category IN (
       'webhooks.upsert_rule',
       'webhooks.delete_rule',
       'webhooks.reorder_rule'
     )
       AND performed_by_system IN (
         'ui_upsert_webhook_rule_v1',
         'ui_delete_webhook_rule_v1',
         'ui_reorder_webhook_rule_v1'
       )
       AND (
         resource_id = current_setting('test.webhook_rule_denied_rule')::UUID
         OR decision_inputs->>'name' IN (
           'Denied public rule create',
           'Denied api rule create',
           'Denied public rule update',
           'Denied api rule update'
         )
       )
  ),
  'denied rule write attempts write no webhook rule lifecycle decision rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.webhook_rule_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.ui_reorder_webhook_rule_v1(jsonb_build_object(
      'rule_id', current_setting('test.webhook_rule_denied_rule'),
      'priority', 125
    ))->>'ok')::BOOLEAN
  ),
  'ops user can still reach webhook rule reorder path'
);
RESET ROLE;

SELECT * FROM finish();

ROLLBACK;
