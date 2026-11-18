-- pgTAP: public.webhook_inbox_replay_v1 contract (allowed/denied/ladder/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b613';
  v_ops UUID := '00000000-0000-0000-0000-00000000b731';
  v_sender UUID := '00000000-0000-0000-0000-00000000b732';
  v_mapping UUID := gen_random_uuid();
  v_source UUID := gen_random_uuid();
  v_hash_source UUID := gen_random_uuid();
  v_inbox UUID := gen_random_uuid();
  v_terminal_inbox UUID := gen_random_uuid();
  v_hash_inbox UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'B6 WI Replay Org', 'b6-wi-rep-org-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'b6-wi-rep-ops-' || left(v_ops::text, 8) || '@example.com',
     'B6 WI Rep Ops', 'ops_admin', 'tenant', NULL),
    (v_sender, v_org, 'b6-wi-rep-sender-' || left(v_sender::text, 8) || '@example.com',
     'B6 WI Rep Sender', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'b6-wi-rep-' || left(v_mapping::text, 8) || '::default',
          '{}'::jsonb, 1, 'B6 WI Replay pgTAP mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
  )
  VALUES (
    v_source,
    v_org,
    'b6-wi-rep-' || left(v_source::text, 8),
    'B6 WI Replay Source',
    'generic',
    'b6-wi-rep-token-' || left(v_source::text, 8),
    v_mapping,
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (id, webhook_source_id, provider_type, raw_payload, processing_status, correlation_id)
  VALUES (v_inbox, v_source, 'generic', '{}'::jsonb, 'failed', gen_random_uuid())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type, auth_token, auth_token_hash, mapping_config_id, enabled
  )
  VALUES (
    v_hash_source,
    v_org,
    'b6-wi-rep-hash-' || left(v_hash_source::text, 8),
    'B6 WI Replay Hashed Source',
    'generic',
    NULL,
    extensions.crypt('b6-wi-rep-hashed-token-' || left(v_hash_source::text, 8), extensions.gen_salt('bf')),
    v_mapping,
    TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (
    id,
    webhook_source_id,
    provider_type,
    event_type,
    raw_payload,
    transformed_payload,
    processing_status,
    correlation_id,
    error_message
  )
  VALUES (
    v_terminal_inbox,
    v_source,
    'generic',
    'shipment.created',
    jsonb_build_object('event_type', 'shipment.created'),
    jsonb_build_object('event_type', 'shipment.created'),
    'failed',
    gen_random_uuid(),
    'execute_shipment_create_v1: missing required webhook shipment recipient/address'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (
    id,
    webhook_source_id,
    provider_type,
    event_type,
    raw_payload,
    transformed_payload,
    processing_status,
    correlation_id,
    error_message
  )
  VALUES (
    v_hash_inbox,
    v_hash_source,
    'generic',
    'shipment.created',
    jsonb_build_object('event', jsonb_build_object('id', 'hash-failed', 'type', 'shipment.created')),
    jsonb_build_object('event', jsonb_build_object('id', 'hash-failed', 'type', 'shipment.created')),
    'failed',
    gen_random_uuid(),
    'execute_shipment_create_v1: missing required webhook shipment recipient/address'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.b6_wi_rep_org', v_org::text, true);
  PERFORM set_config('test.b6_wi_rep_ops', v_ops::text, true);
  PERFORM set_config('test.b6_wi_rep_sender', v_sender::text, true);
  PERFORM set_config('test.b6_wi_rep_inbox', v_inbox::text, true);
  PERFORM set_config('test.b6_wi_rep_terminal_inbox', v_terminal_inbox::text, true);
  PERFORM set_config('test.b6_wi_rep_hash_inbox', v_hash_inbox::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_ops'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.webhook_inbox_replay_v1(jsonb_build_object(
      'webhook_inbox_id', current_setting('test.b6_wi_rep_inbox'),
      'reason', 'pgtap-replay'
    ))->>'ok')::bool
  ),
  'ops_admin can webhook_inbox_replay_v1'
);
RESET ROLE;

-- 2) Terminal shipment-create failures are preserved, not reopened.
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_ops'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT public.webhook_inbox_replay_v1(jsonb_build_object(
      'webhook_inbox_id', current_setting('test.b6_wi_rep_terminal_inbox'),
      'reason', 'pgtap-terminal-replay'
    ))->>'status'
  ),
  'preserved_terminal_failure',
  'webhook_inbox_replay_v1 blocks terminal shipment-create failure replay'
);
RESET ROLE;

SELECT is(
  (
    SELECT processing_status
      FROM public.webhook_inbox
     WHERE id = current_setting('test.b6_wi_rep_terminal_inbox')::uuid
  ),
  'failed',
  'blocked terminal shipment-create replay leaves inbox failed'
);

-- 3) Denied
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.webhook_inbox_replay_v1(jsonb_build_object(
       'webhook_inbox_id', current_setting('test.b6_wi_rep_inbox')
     )) $$,
  '42501',
  NULL,
  'non-admin user denied webhook_inbox_replay_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb_build_object(
       'webhook_inbox_id', current_setting('test.b6_wi_rep_hash_inbox'),
       'reason', 'pgtap-denied-fresh-public'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied public fresh-intake remediation'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_sender'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb_build_object(
       'webhook_inbox_id', current_setting('test.b6_wi_rep_hash_inbox'),
       'reason', 'pgtap-denied-fresh-api'
     )) $$,
  '42501',
  NULL,
  'non-admin user denied api fresh-intake remediation'
);
RESET ROLE;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.webhook_inbox_replays
     WHERE webhook_inbox_id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
       AND action = 'retry_as_new_intake'
       AND reason IN ('pgtap-denied-fresh-public', 'pgtap-denied-fresh-api')
  ),
  'denied fresh-intake remediation writes no retry ledger rows'
);

-- 4) Ladder/audit
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.webhook_inbox_replays
     WHERE webhook_inbox_id = current_setting('test.b6_wi_rep_inbox')::uuid
       AND action = 'replay'
  ),
  'webhook_inbox_replay_v1 wrote webhook_inbox_replays row'
);

-- 5) RLS isolation
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.webhook_inbox_replays', 'select'),
  'authenticated has no SELECT on webhook_inbox_replays (service-only)'
);

-- 6) Fresh-intake remediation preserves the original failed row when the
-- current source token is not recoverable from the DB and instructs operators
-- to resend externally instead of fabricating success.
SELECT set_config('request.jwt.claim.sub', current_setting('test.b6_wi_rep_ops'), true);
SET LOCAL ROLE authenticated;
CREATE TEMP TABLE _hash_retry_result AS
SELECT public.ui_retry_webhook_inbox_as_new_intake_v1(jsonb_build_object(
  'webhook_inbox_id', current_setting('test.b6_wi_rep_hash_inbox'),
  'reason', 'pgtap-hashed-source'
)) AS result;
RESET ROLE;

SELECT is(
  (SELECT result->>'status' FROM _hash_retry_result),
  'external_resend_required',
  'fresh-intake remediation fails closed when source token is not recoverable'
);

SELECT is(
  (SELECT result->>'reason' FROM _hash_retry_result),
  'source_token_not_recoverable',
  'fresh-intake remediation returns operator-readable external resend reason'
);

SELECT is(
  (
    SELECT processing_status
      FROM public.webhook_inbox
     WHERE id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
  ),
  'failed',
  'fresh-intake remediation leaves original failed inbox unchanged'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.webhook_inbox_replays
     WHERE webhook_inbox_id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
       AND action = 'retry_as_new_intake'
       AND forced_status = 'external_resend_required'
  ),
  'fresh-intake remediation writes retry_as_new_intake ledger row'
);

-- 7) Production webhook source tokens are hash-only. Fresh-intake remediation
-- must therefore fail closed without creating hidden duplicate intake rows and
-- must record why the operator needs an external resend.
SELECT is(
  (
    SELECT count(*)::INT
      FROM public.webhook_inbox
     WHERE webhook_source_id = (
       SELECT webhook_source_id
         FROM public.webhook_inbox
        WHERE id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
     )
  ),
  1,
  'fresh-intake remediation does not create a hidden duplicate row for hash-only sources'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.webhook_inbox wi
      JOIN public.webhook_sources ws
        ON ws.id = wi.webhook_source_id
     WHERE wi.id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
       AND ws.auth_token IS NULL
       AND ws.auth_token_hash IS NOT NULL
  ),
  'fresh-intake remediation test source matches production hash-only token storage'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE resource_id = current_setting('test.b6_wi_rep_hash_inbox')::uuid
       AND decision_category = 'webhooks.replay'
       AND decision_outcome = 'external_resend_required'
       AND decision_inputs->>'backend_reason' = 'source_token_not_recoverable'
  ),
  'fresh-intake remediation decision log records source_token_not_recoverable'
);

SELECT ok(
  to_regprocedure('api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_retry_webhook_inbox_as_new_intake_v1(jsonb)', 'EXECUTE'),
  'fresh-intake remediation has an authenticated api-schema wrapper'
);

SELECT * FROM finish();
ROLLBACK;
