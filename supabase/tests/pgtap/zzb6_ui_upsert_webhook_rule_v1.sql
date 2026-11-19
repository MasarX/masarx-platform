-- pgTAP: public.ui_upsert_webhook_rule_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b622';
  v_ops UUID := '00000000-0000-0000-0000-00000000b841';
  v_sender UUID := '00000000-0000-0000-0000-00000000b842';
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WR Upsert Org', 'b6-wr-ups-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wr-ups-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WR Ups Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wr-ups-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WR Ups Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-wr-ups-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WR Upsert pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type,
                                       auth_token, mapping_config_id, enabled)
  VALUES (v_source, v_org, 'b6-wr-ups-' || left(v_source::text, 8),
          'B6 WR Ups Source', 'shopify',
          'b6-wr-ups-init-token-' || left(v_source::text, 8),
          v_mapping, TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wr_ups_org', v_org::text, true);
  PERFORM set_config('test.b6_wr_ups_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wr_ups_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wr_ups_mapping', v_mapping::text, true);
  PERFORM set_config('test.b6_wr_ups_source', v_source::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (create path)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wr_ups_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.ui_upsert_webhook_rule_v1(jsonb_build_object(
      'webhook_source_id', current_setting('test.b6_wr_ups_source'),
      'event_type', 'shipment.created',
      'name', 'B6 WR Ups Rule',
      'priority', 50,
      'mapping_config_id', current_setting('test.b6_wr_ups_mapping'),
      'domain_category', 'shipment'
    ))->>'ok')::bool
  ),
  'ops_admin can ui_upsert_webhook_rule_v1 (create)'
);
RESET ROLE;

-- 2) Denied (sender_user lacks webhooks.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wr_ups_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_webhook_rule_v1(jsonb_build_object(
       'webhook_source_id', current_setting('test.b6_wr_ups_source'),
       'event_type', 'denied',
       'name', 'denied',
       'mapping_config_id', current_setting('test.b6_wr_ups_mapping'),
       'domain_category', 'shipment'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_upsert_webhook_rule_v1'
);
RESET ROLE;

-- 3) Audit / decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'webhooks.upsert_rule'
       AND organization_id = current_setting('test.b6_wr_ups_org')::uuid
  ),
  'ui_upsert_webhook_rule_v1 wrote decision_log row'
);

-- 4) RLS isolation on the underlying table
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_rules'::regclass),
  'webhook_rules has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
