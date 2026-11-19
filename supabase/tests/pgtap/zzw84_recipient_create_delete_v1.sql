-- pgTAP: recipient_create_v1 / recipient_delete_v1 Console V2 lifecycle contract.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(19);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c941';
  v_ops UUID := '00000000-0000-0000-0000-00000000c942';
  v_denied UUID := '00000000-0000-0000-0000-00000000c943';
  v_client UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object('role', 'service_role')::text,
    true
  );
  PERFORM set_config(
    'request.jwt.claim',
    json_build_object('role', 'service_role')::text,
    true
  );

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W84 Rec Lifecycle Org', 'w84-rec-lifecycle-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'w84-rec-ops-' || left(v_ops::text, 8) || '@example.com',
     'W84 Rec Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'W84 Rec Lifecycle Client', 'w84-rec-life-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w84_rec_org', v_org::text, true);
  PERFORM set_config('test.w84_rec_ops', v_ops::text, true);
  PERFORM set_config('test.w84_rec_denied', v_denied::text, true);
  PERFORM set_config('test.w84_rec_client', v_client::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT has_function('public', 'recipient_create_v1', ARRAY['jsonb'], 'recipient_create_v1 public RPC exists');
SELECT has_function('public', 'recipient_update_v1', ARRAY['jsonb'], 'recipient_update_v1 public RPC exists');
SELECT has_function('public', 'recipient_delete_v1', ARRAY['jsonb'], 'recipient_delete_v1 public RPC exists');
SELECT has_function('api', 'recipient_create_v1', ARRAY['jsonb'], 'recipient_create_v1 api wrapper exists');
SELECT has_function('api', 'recipient_update_v1', ARRAY['jsonb'], 'recipient_update_v1 api wrapper exists');
SELECT has_function('api', 'recipient_delete_v1', ARRAY['jsonb'], 'recipient_delete_v1 api wrapper exists');
SELECT has_function('public', 'is_e164_phone_number', ARRAY['text'], 'E.164 recipient phone guard helper exists');

-- Allowed create through api schema wrapper.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_rec_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT set_config(
  'test.w84_rec_created',
  (
    SELECT api.recipient_create_v1(jsonb_build_object(
      'client_id', current_setting('test.w84_rec_client'),
      'name', 'W84 Recipient Create',
      'phone_number', '+966500000941',
      'preferred_language', 'en',
      'preferred_comm_channel', 'whatsapp',
      'external_id', 'W84-REC-941'
    ))->>'recipient_id'
  ),
  true
);
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.recipients
     WHERE id = current_setting('test.w84_rec_created')::uuid
       AND client_id = current_setting('test.w84_rec_client')::uuid
       AND phone_validation_status = 'pending'
  ),
  'ops_admin can create recipient through api wrapper and phone validation starts pending'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE decision_category = 'recipients.create'
       AND resource_id = current_setting('test.w84_rec_created')::uuid
  ),
  'recipient_create_v1 writes decision_log lineage'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_rec_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.recipient_create_v1(jsonb_build_object(
       'client_id', current_setting('test.w84_rec_client'),
       'name', 'Duplicate phone recipient',
       'phone_number', '+966500000941'
     )) $$,
  '23505',
  NULL,
  'recipient_create_v1 rejects duplicate normalized phone for the same client'
);
RESET ROLE;

SELECT is(
  (
    SELECT count(*)::int
      FROM public.recipients
     WHERE client_id = current_setting('test.w84_rec_client')::uuid
       AND name = 'Duplicate phone recipient'
  ),
  0,
  'duplicate phone rejection does not insert a recipient row'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_rec_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.recipient_update_v1(jsonb_build_object(
      'recipient_id', current_setting('test.w84_rec_created'),
      'phone_number', '+966500000944',
      'email', 'w84-rec-updated@example.test',
      'communication_preferences', jsonb_build_object('source', 'pgtap.recipient_update')
    ))->>'ok')::boolean
  ),
  'ops_admin can update recipient through api wrapper'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.recipients
     WHERE id = current_setting('test.w84_rec_created')::uuid
       AND phone_number = '+966500000944'
       AND email = 'w84-rec-updated@example.test'
       AND phone_validation_status = 'pending'
  ),
  'recipient_update_v1 persists operator correction and resets phone validation'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE decision_category = 'recipients.update'
       AND resource_id = current_setting('test.w84_rec_created')::uuid
  ),
  'recipient_update_v1 writes decision_log lineage'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_rec_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.recipient_create_v1(jsonb_build_object(
       'client_id', current_setting('test.w84_rec_client'),
       'name', 'Invalid phone recipient',
       'phone_number', 'not-a-phone'
     )) $$,
  '23514',
  NULL,
  'recipient_create_v1 rejects non-E.164 phone numbers'
);
SELECT throws_ok(
  $$ SELECT api.recipient_update_v1(jsonb_build_object(
       'recipient_id', current_setting('test.w84_rec_created'),
       'phone_number', 'not-a-phone'
     )) $$,
  '23514',
  NULL,
  'recipient_update_v1 rejects non-E.164 phone numbers'
);
RESET ROLE;

-- Denied create for unauthenticated caller.
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.recipient_create_v1(jsonb_build_object(
       'client_id', current_setting('test.w84_rec_client'),
       'name', 'Denied recipient',
       'phone_number', '+966500000942'
     )) $$,
  '42501',
  NULL,
  'unauthenticated caller cannot create recipient'
);
RESET ROLE;

-- Allowed delete through api schema wrapper.
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84_rec_ops'), true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SELECT set_config(
  'request.jwt.claim',
  json_build_object('sub', current_setting('test.w84_rec_ops'), 'role', 'authenticated')::text,
  true
);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (api.recipient_delete_v1(jsonb_build_object(
      'recipient_id', current_setting('test.w84_rec_created'),
      'reason', 'pgtap cleanup'
    ))->>'deleted')::boolean
  ),
  'ops_admin can delete recipient through api wrapper'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE decision_category = 'recipients.delete'
       AND resource_id = current_setting('test.w84_rec_created')::uuid
  ),
  'recipient_delete_v1 writes decision_log lineage'
);

SELECT * FROM finish();
ROLLBACK;
