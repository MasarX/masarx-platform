-- pgTAP: public.ui_reorder_webhook_rule_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b624';
  v_ops UUID := '00000000-0000-0000-0000-00000000b861';
  v_sender UUID := '00000000-0000-0000-0000-00000000b862';
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_rule UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WR Reorder Org', 'b6-wr-reo-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wr-reo-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WR Reo Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wr-reo-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WR Reo Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-wr-reo-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WR Reorder pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type,
                                       auth_token, mapping_config_id, enabled)
  VALUES (v_source, v_org, 'b6-wr-reo-' || left(v_source::text, 8),
          'B6 WR Reo Source', 'shopify',
          'b6-wr-reo-init-token-' || left(v_source::text, 8),
          v_mapping, TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_rules (id, webhook_source_id, event_type, name, priority,
                                     mapping_config_id, domain_category, enabled)
  VALUES
    (v_rule, v_source, 'shipment.created', 'B6 WR Reo Rule', 100, v_mapping, 'shipment', TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wr_reo_org', v_org::text, true);
  PERFORM set_config('test.b6_wr_reo_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wr_reo_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wr_reo_rule', v_rule::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wr_reo_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.ui_reorder_webhook_rule_v1(jsonb_build_object(
      'rule_id', current_setting('test.b6_wr_reo_rule'),
      'priority', 250
    ))->>'ok')::bool
  ),
  'ops_admin can ui_reorder_webhook_rule_v1'
);
RESET ROLE;

-- 2) Denied (sender_user lacks webhooks.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wr_reo_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_reorder_webhook_rule_v1(jsonb_build_object(
       'rule_id', current_setting('test.b6_wr_reo_rule'),
       'priority', 999
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_reorder_webhook_rule_v1'
);
RESET ROLE;

-- 3) Audit / decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'webhooks.reorder_rule'
       AND resource_id = current_setting('test.b6_wr_reo_rule')::uuid
  ),
  'ui_reorder_webhook_rule_v1 wrote decision_log row'
);

-- 4) RLS isolation on the underlying table
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_rules'::regclass),
  'webhook_rules has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
