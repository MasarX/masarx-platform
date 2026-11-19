-- pgTAP: public.ui_upsert_webhook_source_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b620';
  v_ops UUID := '00000000-0000-0000-0000-00000000b821';
  v_sender UUID := '00000000-0000-0000-0000-00000000b822';
  v_mapping UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_source_sender UUID := gen_random_uuid();
  v_policy_version UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WS Upsert Org', 'b6-ws-ups-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-ws-ups-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WS Ups Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-ws-ups-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WS Ups Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Source fixture client', 'source-' || v_client::text, 'active');

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_source_sender, v_client, 'Source fixture sender', 'Fixture', 'active');

  PERFORM set_config('test.b6_ws_ups_source_sender', v_source_sender::text, true);

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-ws-ups-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WS Upsert pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  SELECT settings_version_id INTO STRICT v_policy_version
  FROM public.upsert_settings_value_v1(
    'webhook_source_default_policy',
    'tenant',
    v_org,
    jsonb_build_object('version', 1, 'default_rate_limit_per_hour', 4321),
    1,
    'pgTAP tenant-scoped webhook source default rate limit'
  );
  UPDATE public.settings_versions
     SET effective_from = transaction_timestamp()
   WHERE id = v_policy_version;

  PERFORM set_config('test.b6_ws_ups_org', v_org::text, true);
  PERFORM set_config('test.b6_ws_ups_ops', v_ops::text, true);
  PERFORM set_config('test.b6_ws_ups_sender', v_sender::text, true);
  PERFORM set_config('test.b6_ws_ups_mapping', v_mapping::text, true);
  PERFORM set_config('test.b6_ws_ups_ident', 'b6-ws-ups-' || left(v_mapping::text, 8), true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT is(
  (
    SELECT value->>'default_rate_limit_per_hour'
      FROM public.resolve_settings_row_from_policy_context_v1(
        'webhook_source_default_policy',
        jsonb_build_object(
          'organization_id', current_setting('test.b6_ws_ups_org'),
          'sender_id', current_setting('test.b6_ws_ups_source_sender')
        )
      )
     WHERE scope_type = 'tenant'
       AND scope_id = current_setting('test.b6_ws_ups_org')::uuid
  ),
  '4321',
  'the source sender context resolves the tenant default before creation'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_ups_ops'), true);
SELECT set_config('request.jwt.claim.role', 'authenticated', true);
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.b6_ws_ups_ops'), 'role', 'authenticated'
)::text, true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    WITH created AS (
      SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
      'source_identifier', current_setting('test.b6_ws_ups_ident'),
      'name', 'B6 WS Ups Source',
      'provider_type', 'shopify',
      'sender_id', current_setting('test.b6_ws_ups_source_sender'),
      'mapping_config_id', current_setting('test.b6_ws_ups_mapping')
      )) AS result
    )
    SELECT (result->>'ok')::bool
      AND set_config('test.b6_ws_created_id', result->>'webhook_source_id', true) <> ''
    FROM created
  ),
  'ops_admin can ui_upsert_webhook_source_v1 (create)'
);
RESET ROLE;

-- 2) Omitted create rate limit resolves from tenant-scoped settings policy.
SELECT is(
  (
    SELECT rate_limit_per_hour::text
      FROM public.webhook_sources
     WHERE id = NULLIF(current_setting('test.b6_ws_created_id', true), '')::uuid
       AND organization_id = current_setting('test.b6_ws_ups_org')::uuid
  ),
  '4321',
  'ui_upsert_webhook_source_v1 resolves omitted create rate limit from webhook_source_default_policy'
);

-- 3) Denied (sender_user lacks webhooks.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_ups_sender'), true);
SELECT set_config('request.jwt.claims', jsonb_build_object(
  'sub', current_setting('test.b6_ws_ups_sender'), 'role', 'authenticated'
)::text, true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
       'source_identifier', 'b6-ws-ups-deny',
       'name', 'denied',
       'provider_type', 'generic',
       'mapping_config_id', current_setting('test.b6_ws_ups_mapping')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_upsert_webhook_source_v1'
);
RESET ROLE;

-- 4) Audit / decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'webhooks.upsert_source'
       AND organization_id = current_setting('test.b6_ws_ups_org')::uuid
  ),
  'ui_upsert_webhook_source_v1 wrote decision_log row'
);

-- 5) RLS isolation on the underlying table
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_sources'::regclass),
  'webhook_sources has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
