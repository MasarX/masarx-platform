-- pgTAP: public.ui_upsert_webhook_source_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b620';
  v_ops UUID := '00000000-0000-0000-0000-00000000b821';
  v_sender UUID := '00000000-0000-0000-0000-00000000b822';
  v_mapping UUID := gen_random_uuid();
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

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-ws-ups-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WS Upsert pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  PERFORM public.upsert_settings_value_v1(
    'webhook_source_default_policy',
    'tenant',
    v_org,
    jsonb_build_object('version', 1, 'default_rate_limit_per_hour', 4321),
    1,
    'pgTAP tenant-scoped webhook source default rate limit'
  );

  PERFORM set_config('test.b6_ws_ups_org', v_org::text, true);
  PERFORM set_config('test.b6_ws_ups_ops', v_ops::text, true);
  PERFORM set_config('test.b6_ws_ups_sender', v_sender::text, true);
  PERFORM set_config('test.b6_ws_ups_mapping', v_mapping::text, true);
  PERFORM set_config('test.b6_ws_ups_ident', 'b6-ws-ups-' || left(v_mapping::text, 8), true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (create path)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_ups_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    WITH created AS (
      SELECT public.ui_upsert_webhook_source_v1(jsonb_build_object(
      'source_identifier', current_setting('test.b6_ws_ups_ident'),
      'name', 'B6 WS Ups Source',
      'provider_type', 'shopify',
      'mapping_config_id', current_setting('test.b6_ws_ups_mapping')
      )) AS result
    )
    SELECT (result->>'ok')::bool FROM created
  ),
  'ops_admin can ui_upsert_webhook_source_v1 (create)'
);
RESET ROLE;

-- 2) Omitted create rate limit resolves from tenant-scoped settings policy.
SELECT is(
  (
    SELECT rate_limit_per_hour::text
      FROM public.webhook_sources
     WHERE source_identifier = current_setting('test.b6_ws_ups_ident')
     LIMIT 1
  ),
  '4321',
  'ui_upsert_webhook_source_v1 resolves omitted create rate limit from webhook_source_default_policy'
);

-- 3) Denied (sender_user lacks webhooks.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_ups_sender'), true);
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
