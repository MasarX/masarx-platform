-- pgTAP: public.webhook_inbox_force_status_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b614';
  v_ops UUID := '00000000-0000-0000-0000-00000000b741';
  v_sender UUID := '00000000-0000-0000-0000-00000000b742';
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_inbox UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WI Force Org', 'b6-wi-frc-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wi-frc-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WI Frc Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wi-frc-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WI Frc Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-wi-frc-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WI Force pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_source,
    v_org,
    'b6-wi-frc-' || left(v_source::text, 8),
    'B6 WI Force Source',
    'generic',
    'b6-wi-frc-token-' || left(v_source::text, 8),
    v_mapping,
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (id, webhook_source_id, provider_type, raw_payload, processing_status, correlation_id)
  VALUES (v_inbox, v_source, 'generic', '{}'::jsonb, 'pending', gen_random_uuid())
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wi_frc_org', v_org::text, true);
  PERFORM set_config('test.b6_wi_frc_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wi_frc_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wi_frc_inbox', v_inbox::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_frc_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.webhook_inbox_force_status_v1(jsonb_build_object(
      'webhook_inbox_id', current_setting('test.b6_wi_frc_inbox'),
      'target_status', 'failed',
      'reason', 'pgtap-force'
    ))->>'ok')::bool
  ),
  'ops_admin can webhook_inbox_force_status_v1'
);
RESET ROLE;

-- 2) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_frc_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.webhook_inbox_force_status_v1(jsonb_build_object(
       'webhook_inbox_id', current_setting('test.b6_wi_frc_inbox'),
       'target_status', 'succeeded'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied webhook_inbox_force_status_v1'
);
RESET ROLE;

-- 3) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.webhook_inbox_replays
     WHERE webhook_inbox_id = current_setting('test.b6_wi_frc_inbox')::uuid
       AND action = 'force_status'
       AND forced_status = 'failed'
  ),
  'webhook_inbox_force_status_v1 wrote webhook_inbox_replays row'
);

-- 4) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.webhook_inbox_replays', 'select'),
  'authenticated has no SELECT on webhook_inbox_replays (service-only)'
);

SELECT * FROM finish();
ROLLBACK;
