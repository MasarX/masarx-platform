-- pgTAP: public.compute_bank_account_balance_v1 contract (allowed/denied/projection/RLS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

-- Fixtures: org + bank_account + 2 finance_events (1 in 1000, 1 out 250)
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000c4a0';
  v_bank1 UUID := '00000000-0000-0000-0000-00000000c4a1';
  v_bank2 UUID := '00000000-0000-0000-0000-00000000c4a6';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000c4a2';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000c4a3';
  v_event_in UUID := '00000000-0000-0000-0000-00000000c4a4';
  v_event_out UUID := '00000000-0000-0000-0000-00000000c4a5';
  v_event_statement UUID := '00000000-0000-0000-0000-00000000c4a7';
  v_event_at TIMESTAMPTZ := now() - interval '2 hours';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'W84 Bank Org', 'w84-bank-org-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'w84-bank-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'W84 Bank Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'w84-bank-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'W84 Bank Sender', 'sender_user', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.bank_accounts (id, organization_id, key, name, bank_name, currency, is_active)
  VALUES (v_bank1, v_org1, 'w84-primary-' || left(v_bank1::text, 8), 'W84 Primary', 'Test Bank', 'sar', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.bank_accounts (id, organization_id, key, name, bank_name, currency, is_active)
  VALUES (v_bank2, v_org1, 'w84-statement-' || left(v_bank2::text, 8), 'W84 Statement', 'Test Bank', 'sar', TRUE)
  ON CONFLICT (id) DO NOTHING;

  -- Two finance_events scoped to this bank account: balance = 1000 - 250 = 750.
  INSERT INTO public.finance_events (
    id, organization_id, event_type, direction, amount, currency,
    account_type, account_id, occurred_at
  ) VALUES (
    v_event_in, v_org1, 'deposit', 'in', 1000, 'sar',
    'bank', v_bank1, v_event_at
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.finance_events (
    id, organization_id, event_type, direction, amount, currency,
    account_type, account_id, occurred_at
  ) VALUES (
    v_event_out, v_org1, 'payout', 'out', 250, 'sar',
    'bank', v_bank1, v_event_at
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.finance_events (
    id, organization_id, event_type, direction, amount, currency,
    account_type, account_id, occurred_at, metadata
  ) VALUES (
    v_event_statement, v_org1, 'bank_statement', 'in', 321.45, 'sar',
    'bank_account', v_bank2, v_event_at, jsonb_build_object('source', 'pgtap')
  )
  ON CONFLICT DO NOTHING;

  PERFORM set_config('test.w84b_org1', v_org1::text, true);
  PERFORM set_config('test.w84b_bank1', v_bank1::text, true);
  PERFORM set_config('test.w84b_bank2', v_bank2::text, true);
  PERFORM set_config('test.w84b_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.w84b_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can read projection
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84b_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT ok(
  (
    SELECT (public.compute_bank_account_balance_v1(jsonb_build_object(
      'bank_account_id', current_setting('test.w84b_bank1')
    ))->>'ok')::bool
  ),
  'ops_admin can compute_bank_account_balance_v1'
);

-- 2) Projection: balance = 750 (1000 in - 250 out)
SELECT is(
  (
    public.compute_bank_account_balance_v1(jsonb_build_object(
      'bank_account_id', current_setting('test.w84b_bank1')
    ))->>'balance'
  ),
  '750',
  'balance projection sums in/out finance_events to 750'
);

SELECT is(
  (
    SELECT jsonb_build_object(
      'balance', projection->>'balance',
      'open_items', projection->>'open_items'
    )::text
    FROM public.compute_bank_account_balance_v1(jsonb_build_object(
      'bank_account_id', current_setting('test.w84b_bank2')
    )) AS projection
  ),
  jsonb_build_object('balance', '321.45', 'open_items', '1')::text,
  'projection reads canonical account_type=bank_account statement events'
);
RESET ROLE;

-- 3) Denied: sender_user lacks finance.read
SELECT set_config('request.jwt.claim.sub', current_setting('test.w84b_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.compute_bank_account_balance_v1(jsonb_build_object(
       'bank_account_id', current_setting('test.w84b_bank1')
     )) $$,
  '42501',
  NULL,
  'sender_user denied compute_bank_account_balance_v1 (finance.read missing)'
);
RESET ROLE;

-- 4) Capability registry: finance.read is a registered baseline capability
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'finance.read'
  ),
  'finance.read is registered as a baseline rbac_permission lookup value'
);

-- 5) Function is SECURITY DEFINER (read-path tenant isolation enforced in body)
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = 'compute_bank_account_balance_v1'
       AND p.prosecdef = TRUE
  ),
  'compute_bank_account_balance_v1 is SECURITY DEFINER'
);

SELECT * FROM finish();
ROLLBACK;
