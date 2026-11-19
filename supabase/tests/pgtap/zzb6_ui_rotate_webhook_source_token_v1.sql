-- pgTAP: public.ui_rotate_webhook_source_token_v1 contract (allowed/denied/audit/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b621';
  v_ops UUID := '00000000-0000-0000-0000-00000000b831';
  v_sender UUID := '00000000-0000-0000-0000-00000000b832';
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WS Rotate Org', 'b6-ws-rot-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-ws-rot-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WS Rot Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-ws-rot-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WS Rot Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-ws-rot-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WS Rotate pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (id, organization_id, source_identifier, name, provider_type,
                                       auth_token, mapping_config_id, enabled)
  VALUES (v_source, v_org, 'b6-ws-rot-' || left(v_source::text, 8),
          'B6 WS Rotate Source', 'shopify',
          'b6-ws-rot-init-token-' || left(v_source::text, 8),
          v_mapping, TRUE)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_ws_rot_org', v_org::text, true);
  PERFORM set_config('test.b6_ws_rot_ops', v_ops::text, true);
  PERFORM set_config('test.b6_ws_rot_sender', v_sender::text, true);
  PERFORM set_config('test.b6_ws_rot_source', v_source::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed (rotate succeeds and returns token)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_rot_ops'), true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE _ws_rotate_result AS
SELECT public.ui_rotate_webhook_source_token_v1(jsonb_build_object(
  'source_id', current_setting('test.b6_ws_rot_source')
)) AS result;

SELECT ok(
  (SELECT (result->>'ok')::bool FROM _ws_rotate_result),
  'ops_admin can ui_rotate_webhook_source_token_v1'
);
SELECT ok(
  (SELECT length(result->>'auth_token') = 64 FROM _ws_rotate_result),
  'ui_rotate_webhook_source_token_v1 returns one-time 64-char token'
);
SELECT ok(
  (
    SELECT result->>'correlation_id'
      ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    FROM _ws_rotate_result
  ),
  'ui_rotate_webhook_source_token_v1 returns UUID-shaped correlation_id'
);
RESET ROLE;

-- 2) Denied (sender_user lacks webhooks.write)
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_ws_rot_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_rotate_webhook_source_token_v1(jsonb_build_object(
       'source_id', current_setting('test.b6_ws_rot_source')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied ui_rotate_webhook_source_token_v1'
);
RESET ROLE;

-- 3) Audit / decision_log row written
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE decision_category = 'webhooks.rotate_source_token'
       AND resource_id = current_setting('test.b6_ws_rot_source')::uuid
  ),
  'ui_rotate_webhook_source_token_v1 wrote decision_log row'
);

-- 4) RLS isolation on the underlying table
SELECT ok(
  (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.webhook_sources'::regclass),
  'webhook_sources has RLS enabled'
);

SELECT * FROM finish();
ROLLBACK;
