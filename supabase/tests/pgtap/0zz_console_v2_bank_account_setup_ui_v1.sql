-- pgTAP: Console V2 bank account setup browser RPC.
-- Proves first-account setup is finance.write-gated, scoped to the caller org,
-- stores only safe last4 identifiers, and is readable through the api schema.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000b9a0';
  v_other_org UUID := '00000000-0000-0000-0000-00000000b9a1';
  v_limited_user UUID := '00000000-0000-0000-0000-00000000b9a2';
  v_ops_user UUID := '00000000-0000-0000-0000-00000000b9a3';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Console V2 Bank Account Setup Org', 'console-v2-bank-account-setup-primary'),
    (v_other_org, 'Console V2 Bank Account Setup Other Org', 'console-v2-bank-account-setup-other')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (
      v_limited_user,
      v_org,
      'console-v2-bank-account-readonly-' || left(v_limited_user::text, 8) || '@example.com',
      'Console V2 Bank Account Readonly',
      'account_manager',
      'tenant',
      NULL
    ),
    (
      v_ops_user,
      v_org,
      'console-v2-bank-account-ops-' || left(v_ops_user::text, 8) || '@example.com',
      'Console V2 Bank Account Ops',
      'ops_admin',
      'tenant',
      NULL
    )
  ON CONFLICT (id) DO UPDATE
  SET organization_id = EXCLUDED.organization_id,
      email = EXCLUDED.email,
      full_name = EXCLUDED.full_name,
      user_type = EXCLUDED.user_type,
      access_scope_type = EXCLUDED.access_scope_type,
      access_scope_id = EXCLUDED.access_scope_id;

  DELETE FROM public.bank_accounts
  WHERE organization_id IN (v_org, v_other_org)
    AND key LIKE 'cv2-bank-account-setup-%';

  PERFORM set_config('test.cv2_bank_account_setup_org', v_org::text, true);
  PERFORM set_config('test.cv2_bank_account_setup_other_org', v_other_org::text, true);
  PERFORM set_config('test.cv2_bank_account_setup_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_bank_account_setup_ops_user', v_ops_user::text, true);
  PERFORM set_config(
    'test.cv2_bank_account_setup_count_before',
    (SELECT COUNT(*)::text FROM public.bank_accounts WHERE organization_id = v_org),
    true
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT has_function('public', 'ui_create_bank_account_v1', ARRAY['jsonb'], 'public ui_create_bank_account_v1 exists');
SELECT has_function('api', 'ui_create_bank_account_v1', ARRAY['jsonb'], 'api ui_create_bank_account_v1 exists');

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_bank_account_setup_limited_user'), true);
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_create_bank_account_v1(jsonb_build_object(
       'key', 'cv2-bank-account-setup-denied',
       'name', 'Denied Account',
       'currency', 'sar'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_create_bank_account_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_create_bank_account_v1(jsonb_build_object(
       'key', 'cv2-bank-account-setup-denied-api',
       'name', 'Denied Account API',
       'currency', 'sar'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_create_bank_account_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.bank_accounts WHERE organization_id = current_setting('test.cv2_bank_account_setup_org')::uuid),
  current_setting('test.cv2_bank_account_setup_count_before'),
  'denied bank account setup does not create bank_accounts rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_bank_account_setup_ops_user'), true);
SELECT set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_create_bank_account_v1(jsonb_build_object(
       'key', 'cv2-bank-account-setup-full-id',
       'name', 'Full Identifier Blocked',
       'currency', 'sar',
       'account_number', '1234567890123456'
     )) $$,
  '23514',
  NULL,
  'ops operator cannot submit full bank account identifiers'
);

SELECT throws_ok(
  $$ SELECT api.ui_create_bank_account_v1(jsonb_build_object(
       'organization_id', current_setting('test.cv2_bank_account_setup_other_org'),
       'key', 'cv2-bank-account-setup-other-org',
       'name', 'Wrong Org Account',
       'currency', 'sar'
     )) $$,
  '42501',
  NULL,
  'ops operator cannot create a bank account for another organization'
);

SELECT set_config(
  'test.cv2_bank_account_setup_created_id',
  (
    SELECT api.ui_create_bank_account_v1(jsonb_build_object(
      'key', 'cv2-bank-account-setup-main',
      'name', 'Console V2 Main Clearing',
      'bank_name', 'Saudi Bank',
      'currency', 'sar',
      'iban_last4', '1234',
      'account_last4', '9876',
      'metadata', jsonb_build_object('source', 'pgtap')
    ))->>'bank_account_id'
  ),
  true
);

SELECT ok(
  current_setting('test.cv2_bank_account_setup_created_id')::uuid IS NOT NULL,
  'ops operator can create bank account through api wrapper'
);

SELECT is(
  (api.ui_get_resource_v1('bank_accounts', current_setting('test.cv2_bank_account_setup_created_id')::uuid)->>'key'),
  'cv2-bank-account-setup-main',
  'created bank account is readable through api.ui_get_resource_v1'
);

SELECT ok(
  (api.ui_list_resource_v1('bank_accounts', jsonb_build_object('key', 'cv2-bank-account-setup-main'), 5, 0, NULL::jsonb)->>'total')::integer = 1,
  'created bank account appears in browser-safe bank_accounts list readback'
);

RESET ROLE;

SELECT is(
  (
    SELECT jsonb_build_object(
      'currency', currency,
      'iban_last4', iban_last4,
      'account_last4', account_last4,
      'iban_sha256_is_null', iban_sha256 IS NULL,
      'account_sha256_is_null', account_sha256 IS NULL
    )::text
    FROM public.bank_accounts
    WHERE id = current_setting('test.cv2_bank_account_setup_created_id')::uuid
  ),
  jsonb_build_object(
    'currency', 'SAR',
    'iban_last4', '1234',
    'account_last4', '9876',
    'iban_sha256_is_null', TRUE,
    'account_sha256_is_null', TRUE
  )::text,
  'created bank account stores normalized currency and only safe last4 identifiers'
);

SELECT * FROM finish();

ROLLBACK;
