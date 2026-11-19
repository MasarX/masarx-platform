-- pgTAP: Console V2 bank reconciliation write denied-state guard.
-- Ensures read-only finance operators cannot ingest bank statements, match,
-- unmatch, or start the reconciliation workflow through public/api RPC paths.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(24);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d8a0';
  v_bank_account UUID := '00000000-0000-0000-0000-00000000d8a1';
  v_limited_user UUID := '00000000-0000-0000-0000-00000000d8a2';
  v_ops_user UUID := '00000000-0000-0000-0000-00000000d8a3';
  v_invoice UUID := '00000000-0000-0000-0000-00000000d8a4';
  v_existing_match UUID := '00000000-0000-0000-0000-00000000d8a5';
  v_existing_event UUID := '00000000-0000-0000-0000-00000000d8a6';
  v_match_event UUID := '00000000-0000-0000-0000-00000000d8a7';
  v_client UUID := '00000000-0000-0000-0000-00000000d8a8';
  v_branch UUID := '00000000-0000-0000-0000-00000000d8a9';
  v_template UUID := '99990000-0000-0000-0000-000000570004';
  v_period_start TIMESTAMPTZ := date_trunc('month', now());
  v_period_end TIMESTAMPTZ := date_trunc('month', now()) + interval '1 month' - interval '1 second';
  v_due_at TIMESTAMPTZ := date_trunc('month', now()) + interval '1 month 14 days';
  v_statement_at TIMESTAMPTZ := date_trunc('month', now()) + interval '14 days 10 hours';
  v_statement_at_1 TIMESTAMPTZ := date_trunc('month', now()) + interval '14 days 10 hours 1 minute';
  v_statement_at_2 TIMESTAMPTZ := date_trunc('month', now()) + interval '14 days 10 hours 2 minutes';
  v_existing_match_at TIMESTAMPTZ := date_trunc('month', now()) + interval '14 days 9 hours 5 minutes';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Bank Recon Denied Org', 'console-v2-bank-recon-denied-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console V2 Bank Recon Denied Client', 'console-v2-bank-recon-denied-' || left(v_client::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'cv2-bank-recon-denied', 'Console V2 Bank Recon Denied Branch', TRUE)
  ON CONFLICT (id) DO UPDATE
  SET code = EXCLUDED.code,
      name = EXCLUDED.name,
      is_active = EXCLUDED.is_active,
      updated_at = now();

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited_user,
    v_org,
    'console-v2-bank-recon-readonly-' || left(v_limited_user::text, 8) || '@example.com',
    'Console V2 Bank Recon Readonly',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_user,
    v_org,
    'console-v2-bank-recon-ops-' || left(v_ops_user::text, 8) || '@example.com',
    'Console V2 Bank Recon Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.bank_accounts (
    id, organization_id, key, name, bank_name, currency,
    iban_last4, account_last4, is_active, metadata
  )
  VALUES (
    v_bank_account, v_org, 'cv2-bank-recon-denied-001',
    'Console V2 Denied Bank Account', 'Test Bank', 'sar',
    '8001', '9001', TRUE, '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
  SET key = EXCLUDED.key,
      name = EXCLUDED.name,
      bank_name = EXCLUDED.bank_name,
      currency = EXCLUDED.currency,
      iban_last4 = EXCLUDED.iban_last4,
      account_last4 = EXCLUDED.account_last4,
      is_active = EXCLUDED.is_active,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, invoice_number, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, due_at,
    created_by_user_id, idempotency_key, version, metadata
  )
  VALUES (
    v_invoice, v_org, v_client, 'CV2-BANK-RECON-DENIED', 'issued', 'sar',
    100, 15, 115, 0, 115,
    v_period_start, v_period_end, v_due_at,
    v_ops_user, 'cv2-bank-recon-denied-invoice', 1, '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      currency = EXCLUDED.currency,
      subtotal = EXCLUDED.subtotal,
      tax_total = EXCLUDED.tax_total,
      total = EXCLUDED.total,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      version = EXCLUDED.version,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  INSERT INTO public.bank_recon_matches (
    id, organization_id,
    bank_statement_event_id, bank_statement_occurred_at,
    resource_type, resource_id,
    matched_amount, currency,
    status, match_reason, unmatch_reason,
    matched_by, matched_at, unmatched_by, unmatched_at,
    metadata
  )
  VALUES (
    v_existing_match, v_org,
    v_existing_event, v_statement_at,
    'billing_invoice', v_invoice,
    115, 'sar',
    'matched', 'fixture', NULL,
    v_ops_user, v_existing_match_at, NULL, NULL,
    '{}'::jsonb
  )
  ON CONFLICT (id) DO UPDATE
  SET status = 'matched',
      match_reason = 'fixture',
      unmatch_reason = NULL,
      matched_by = EXCLUDED.matched_by,
      matched_at = EXCLUDED.matched_at,
      unmatched_by = NULL,
      unmatched_at = NULL,
      metadata = '{}'::jsonb,
      updated_at = now();

  DELETE FROM public.decision_log
  WHERE organization_id = v_org
    AND resource_type IN ('bank_account', 'bank_recon_match', 'workflow_run');

  DELETE FROM public.domain_events
  WHERE organization_id = v_org
    AND resource_type IN ('finance_event', 'bank_recon_match', 'workflow_run');

  PERFORM set_config('test.cv2_bank_recon_org', v_org::text, true);
  PERFORM set_config('test.cv2_bank_recon_bank_account', v_bank_account::text, true);
  PERFORM set_config('test.cv2_bank_recon_bank_account_key', 'cv2-bank-recon-denied-001', true);
  PERFORM set_config('test.cv2_bank_recon_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_bank_recon_ops_user', v_ops_user::text, true);
  PERFORM set_config('test.cv2_bank_recon_invoice', v_invoice::text, true);
  PERFORM set_config('test.cv2_bank_recon_existing_match', v_existing_match::text, true);
  PERFORM set_config('test.cv2_bank_recon_existing_event', v_existing_event::text, true);
  PERFORM set_config('test.cv2_bank_recon_match_event', v_match_event::text, true);
  PERFORM set_config('test.cv2_bank_recon_branch', v_branch::text, true);
  PERFORM set_config('test.cv2_bank_recon_template', v_template::text, true);
  PERFORM set_config('test.cv2_bank_recon_statement_at', v_statement_at::text, true);
  PERFORM set_config('test.cv2_bank_recon_statement_at_1', v_statement_at_1::text, true);
  PERFORM set_config('test.cv2_bank_recon_statement_at_2', v_statement_at_2::text, true);

  PERFORM set_config(
    'test.cv2_bank_recon_finance_event_count_before',
    (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_bank_recon_match_count_before',
    (SELECT COUNT(*)::text FROM public.bank_recon_matches WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_bank_recon_workflow_run_count_before',
    (SELECT COUNT(*)::text FROM public.workflow_runs WHERE context->>'organization_id' = v_org::text),
    true
  );
  PERFORM set_config(
    'test.cv2_bank_recon_decision_count_before',
    (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_bank_recon_domain_event_count_before',
    (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = v_org),
    true
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_bank_recon_limited_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_record_bank_statement_event_v1(jsonb_build_object(
       'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
       'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
       'direction', 'in',
       'amount', 123.45,
       'currency', 'sar',
       'occurred_at', current_setting('test.cv2_bank_recon_statement_at'),
       'idempotency_key', 'cv2-bank-recon-denied-public-ingest'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_record_bank_statement_event_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_record_bank_statement_event_v1(jsonb_build_object(
       'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
       'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
       'direction', 'in',
       'amount', 123.45,
       'currency', 'sar',
       'occurred_at', current_setting('test.cv2_bank_recon_statement_at_1'),
       'idempotency_key', 'cv2-bank-recon-denied-api-ingest'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_record_bank_statement_event_v1'
);

SELECT throws_ok(
  $$ SELECT public.bank_recon_match_v1(jsonb_build_object(
       'bank_statement_event_id', current_setting('test.cv2_bank_recon_match_event'),
       'bank_statement_occurred_at', current_setting('test.cv2_bank_recon_statement_at'),
       'resource_type', 'billing_invoice',
       'resource_id', current_setting('test.cv2_bank_recon_invoice'),
       'matched_amount', 115,
       'currency', 'sar',
       'match_reason', 'denied-public-match'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.bank_recon_match_v1'
);

SELECT throws_ok(
  $$ SELECT api.bank_recon_match_v1(jsonb_build_object(
       'bank_statement_event_id', current_setting('test.cv2_bank_recon_match_event'),
       'bank_statement_occurred_at', current_setting('test.cv2_bank_recon_statement_at'),
       'resource_type', 'billing_invoice',
       'resource_id', current_setting('test.cv2_bank_recon_invoice'),
       'matched_amount', 115,
       'currency', 'sar',
       'match_reason', 'denied-api-match'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.bank_recon_match_v1'
);

SELECT throws_ok(
  $$ SELECT public.bank_recon_unmatch_v1(jsonb_build_object(
       'bank_recon_match_id', current_setting('test.cv2_bank_recon_existing_match'),
       'unmatch_reason', 'denied-public-unmatch'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.bank_recon_unmatch_v1'
);

SELECT throws_ok(
  $$ SELECT api.bank_recon_unmatch_v1(jsonb_build_object(
       'bank_recon_match_id', current_setting('test.cv2_bank_recon_existing_match'),
       'unmatch_reason', 'denied-api-unmatch'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.bank_recon_unmatch_v1'
);

SELECT throws_ok(
  $$ SELECT public.ui_start_workflow_run_v1(
       current_setting('test.cv2_bank_recon_template')::uuid,
       jsonb_build_object(
         'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
         'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
         'kind', 'deposit',
         'scope_type', 'branch_day',
         'branch_id', current_setting('test.cv2_bank_recon_branch'),
         'subject_type', 'branch',
         'subject_id', current_setting('test.cv2_bank_recon_branch')
       ),
       TRUE
     ) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_start_workflow_run_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_start_workflow_run_v1(
       current_setting('test.cv2_bank_recon_template')::uuid,
       jsonb_build_object(
         'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
         'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
         'kind', 'deposit',
         'scope_type', 'branch_day',
         'branch_id', current_setting('test.cv2_bank_recon_branch'),
         'subject_type', 'branch',
         'subject_id', current_setting('test.cv2_bank_recon_branch')
       ),
       TRUE
     ) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_start_workflow_run_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  current_setting('test.cv2_bank_recon_finance_event_count_before'),
  'denied bank reconciliation writes do not append finance_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.bank_recon_matches WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  current_setting('test.cv2_bank_recon_match_count_before'),
  'denied bank reconciliation writes do not append bank_recon_matches'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'unmatched_by', unmatched_by, 'unmatched_at', unmatched_at, 'unmatch_reason', unmatch_reason)::text
     FROM public.bank_recon_matches
    WHERE id = current_setting('test.cv2_bank_recon_existing_match')::uuid),
  jsonb_build_object('status', 'matched', 'unmatched_by', NULL, 'unmatched_at', NULL, 'unmatch_reason', NULL)::text,
  'denied unmatch leaves existing match unchanged'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.workflow_runs WHERE context->>'organization_id' = current_setting('test.cv2_bank_recon_org')),
  current_setting('test.cv2_bank_recon_workflow_run_count_before'),
  'denied reconciliation workflow start does not create workflow_runs'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  current_setting('test.cv2_bank_recon_decision_count_before'),
  'denied bank reconciliation writes do not append decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  current_setting('test.cv2_bank_recon_domain_event_count_before'),
  'denied bank reconciliation writes do not append domain_events'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_bank_recon_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.ui_record_bank_statement_event_v1(jsonb_build_object(
      'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
      'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
      'direction', 'in',
      'amount', 123.45,
      'currency', 'sar',
      'occurred_at', current_setting('test.cv2_bank_recon_statement_at_2'),
      'idempotency_key', 'cv2-bank-recon-allowed-api-ingest',
      'metadata', jsonb_build_object('statement_reference', 'allowed-api-ingest')
    ))->>'ok')::boolean
  ),
  'ops operator can ingest bank statement through api wrapper'
);

SELECT ok(
  (
    SELECT (api.bank_recon_match_v1(jsonb_build_object(
      'bank_statement_event_id', current_setting('test.cv2_bank_recon_match_event'),
      'bank_statement_occurred_at', current_setting('test.cv2_bank_recon_statement_at'),
      'resource_type', 'billing_invoice',
      'resource_id', current_setting('test.cv2_bank_recon_invoice'),
      'matched_amount', 115,
      'currency', 'sar',
      'match_reason', 'allowed-api-match'
    ))->>'ok')::boolean
  ),
  'ops operator can match bank statement through api wrapper'
);

SELECT ok(
  (
    SELECT (api.bank_recon_unmatch_v1(jsonb_build_object(
      'bank_recon_match_id', current_setting('test.cv2_bank_recon_existing_match'),
      'unmatch_reason', 'allowed-api-unmatch'
    ))->>'ok')::boolean
  ),
  'ops operator can unmatch bank reconciliation pair through api wrapper'
);

SELECT ok(
  (
    SELECT (api.ui_start_workflow_run_v1(
      current_setting('test.cv2_bank_recon_template')::uuid,
      jsonb_build_object(
        'bank_account_id', current_setting('test.cv2_bank_recon_bank_account'),
        'bank_account_key', current_setting('test.cv2_bank_recon_bank_account_key'),
        'kind', 'deposit',
        'scope_type', 'branch_day',
        'branch_id', current_setting('test.cv2_bank_recon_branch'),
        'subject_type', 'branch',
        'subject_id', current_setting('test.cv2_bank_recon_branch')
      ),
      TRUE
    )->>'workflow_run_id') IS NOT NULL
  ),
  'ops operator can start reconciliation workflow through api wrapper'
);

RESET ROLE;

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_bank_recon_finance_event_count_before')::integer + 1
     FROM public.finance_events
    WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  'allowed bank statement ingest appends finance_events'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_bank_recon_match_count_before')::integer + 1
     FROM public.bank_recon_matches
    WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  'allowed bank reconciliation match appends bank_recon_matches'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'unmatch_reason', unmatch_reason)::text
     FROM public.bank_recon_matches
    WHERE id = current_setting('test.cv2_bank_recon_existing_match')::uuid),
  jsonb_build_object('status', 'unmatched', 'unmatch_reason', 'allowed-api-unmatch')::text,
  'allowed unmatch updates existing match state'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_bank_recon_workflow_run_count_before')::integer + 1
     FROM public.workflow_runs
    WHERE context->>'organization_id' = current_setting('test.cv2_bank_recon_org')),
  'allowed reconciliation workflow start appends workflow_runs'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_bank_recon_decision_count_before')::integer + 3
     FROM public.decision_log
    WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  'allowed bank reconciliation writes append decision_log rows'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_bank_recon_domain_event_count_before')::integer + 2
     FROM public.domain_events
    WHERE organization_id = current_setting('test.cv2_bank_recon_org')::uuid),
  'allowed bank reconciliation writes append domain_events'
);

SELECT * FROM finish();
ROLLBACK;
