-- pgTAP: Console V2 finance ledger reversal denied-state guard.
-- Ensures read-only finance operators cannot append reversal ledger rows
-- through public/api RPC paths and that the original immutable event remains
-- unchanged.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000daa0';
  v_limited_user UUID := '00000000-0000-0000-0000-00000000daa1';
  v_ops_user UUID := '00000000-0000-0000-0000-00000000daa2';
  v_platform_home_org UUID := '00000000-0000-0000-0000-00000000daa4';
  v_platform_user UUID := '00000000-0000-0000-0000-00000000daa5';
  v_account UUID := '00000000-0000-0000-0000-00000000daa3';
  v_finance_event UUID;
  v_platform_finance_event UUID;
  v_event_at TIMESTAMPTZ := date_trunc('month', now()) + interval '15 days 12 hours';
  v_platform_event_at TIMESTAMPTZ := date_trunc('month', now()) + interval '15 days 13 hours';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Ledger Reverse Denied Org', 'console-v2-ledger-reverse-denied-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_platform_home_org, 'Console V2 Ledger Reverse Platform Home Org', 'console-v2-ledger-reverse-platform-home-' || left(v_platform_home_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited_user,
    v_org,
    'console-v2-ledger-readonly-' || left(v_limited_user::text, 8) || '@example.com',
    'Console V2 Ledger Readonly',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_user,
    v_org,
    'console-v2-ledger-ops-' || left(v_ops_user::text, 8) || '@example.com',
    'Console V2 Ledger Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_platform_user,
    v_platform_home_org,
    'console-v2-ledger-platform-' || left(v_platform_user::text, 8) || '@example.com',
    'Console V2 Ledger Platform Ops',
    'super_admin',
    'platform',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  DELETE FROM public.domain_events
  WHERE organization_id = v_org
    AND resource_type = 'finance_event';

  DELETE FROM public.decision_log
  WHERE organization_id = v_org
    AND resource_type = 'finance_event';

  SELECT finance_event_id
    INTO v_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'deposit',
    'direction', 'credit',
    'amount', 125.50,
    'currency', 'sar',
    'account_type', 'company',
    'account_id', v_account,
    'idempotency_key', 'console-v2-ledger-reverse-denied-original',
    'metadata', jsonb_build_object('fixture', 'ledger_reverse_denied'),
    'occurred_at', v_event_at
  ))
  LIMIT 1;

  SELECT finance_event_id
    INTO v_platform_finance_event
  FROM public.record_finance_event_v1(jsonb_build_object(
    'organization_id', v_org,
    'event_type', 'deposit',
    'direction', 'credit',
    'amount', 126.75,
    'currency', 'sar',
    'account_type', 'company',
    'account_id', v_account,
    'idempotency_key', 'console-v2-ledger-reverse-platform-original',
    'metadata', jsonb_build_object('fixture', 'ledger_reverse_platform_active_tenant'),
    'occurred_at', v_platform_event_at
  ))
  LIMIT 1;

  DELETE FROM public.domain_events
  WHERE organization_id = v_org
    AND resource_type = 'finance_event';

  DELETE FROM public.decision_log
  WHERE organization_id = v_org
    AND resource_type = 'finance_event';

  PERFORM set_config('test.cv2_ledger_reverse_org', v_org::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_ops_user', v_ops_user::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_platform_user', v_platform_user::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_platform_home_org', v_platform_home_org::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_event', v_finance_event::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_platform_event', v_platform_finance_event::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_event_at', v_event_at::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_platform_event_at', v_platform_event_at::text, true);
  PERFORM set_config('test.cv2_ledger_reverse_event_count_before', (
    SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = v_org
  ), true);
  PERFORM set_config('test.cv2_ledger_reverse_decision_count_before', (
    SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = v_org AND resource_type = 'finance_event'
  ), true);
  PERFORM set_config('test.cv2_ledger_reverse_domain_event_count_before', (
    SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = v_org AND resource_type = 'finance_event'
  ), true);
  PERFORM set_config('test.cv2_ledger_reverse_original_state_before', (
    SELECT jsonb_build_object(
      'event_type', event_type,
      'direction', direction,
      'amount', amount,
      'currency', currency,
      'account_type', account_type,
      'account_id', account_id,
      'metadata', metadata
    )::text
    FROM public.finance_events
    WHERE id = v_finance_event
      AND organization_id = v_org
      AND occurred_at = v_event_at
  ), true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_ledger_reverse_limited_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_reverse_finance_event_v1(jsonb_build_object(
       'finance_event_id', current_setting('test.cv2_ledger_reverse_event'),
       'finance_occurred_at', current_setting('test.cv2_ledger_reverse_event_at'),
       'reason', 'denied public ledger reversal'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_reverse_finance_event_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_reverse_finance_event_v1(jsonb_build_object(
       'finance_event_id', current_setting('test.cv2_ledger_reverse_event'),
       'finance_occurred_at', current_setting('test.cv2_ledger_reverse_event_at'),
       'reason', 'denied api ledger reversal'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_reverse_finance_event_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  current_setting('test.cv2_ledger_reverse_event_count_before'),
  'denied ledger reversal does not append finance_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_decision_count_before'),
  'denied ledger reversal appends no decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_domain_event_count_before'),
  'denied ledger reversal appends no domain_events rows'
);

SELECT is(
  (SELECT jsonb_build_object(
      'event_type', event_type,
      'direction', direction,
      'amount', amount,
      'currency', currency,
      'account_type', account_type,
      'account_id', account_id,
      'metadata', metadata
    )::text
   FROM public.finance_events
   WHERE id = current_setting('test.cv2_ledger_reverse_event')::uuid
     AND organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
     AND occurred_at = current_setting('test.cv2_ledger_reverse_event_at')::timestamptz),
  current_setting('test.cv2_ledger_reverse_original_state_before'),
  'denied ledger reversal leaves original finance_event unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_ledger_reverse_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.ui_reverse_finance_event_v1(jsonb_build_object(
      'finance_event_id', current_setting('test.cv2_ledger_reverse_event'),
      'finance_occurred_at', current_setting('test.cv2_ledger_reverse_event_at'),
      'reason', 'allowed ledger reversal reason'
    ))->>'ok')::boolean
  ),
  'ops operator can reverse finance event through api wrapper'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  ((current_setting('test.cv2_ledger_reverse_event_count_before')::integer + 1)::text),
  'allowed ledger reversal appends one inverse finance_event'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.finance_events fe
     WHERE fe.organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
       AND fe.event_type = 'adjustment'
       AND fe.direction = 'debit'
       AND fe.amount = 125.50
       AND fe.metadata->>'reversal' = 'true'
       AND fe.metadata->>'reverses_finance_event_id' = current_setting('test.cv2_ledger_reverse_event')
       AND fe.metadata->>'reversal_reason' = 'allowed ledger reversal reason'
  ),
  'allowed ledger reversal records inverse adjustment metadata'
);

SELECT is(
  (SELECT jsonb_build_object(
      'event_type', event_type,
      'direction', direction,
      'amount', amount,
      'currency', currency,
      'account_type', account_type,
      'account_id', account_id,
      'metadata', metadata
    )::text
   FROM public.finance_events
   WHERE id = current_setting('test.cv2_ledger_reverse_event')::uuid
     AND organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
     AND occurred_at = current_setting('test.cv2_ledger_reverse_event_at')::timestamptz),
  current_setting('test.cv2_ledger_reverse_original_state_before'),
  'allowed ledger reversal still preserves original finance_event'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  ((current_setting('test.cv2_ledger_reverse_decision_count_before')::integer + 1)::text),
  'allowed ledger reversal appends expected decision_log row'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.finance_events_ledger fel
     WHERE fel.organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
       AND fel.metadata->>'reverses_finance_event_id' = current_setting('test.cv2_ledger_reverse_event')
  ),
  'allowed ledger reversal is visible through finance_events_ledger projection'
);

SELECT set_config('test.cv2_ledger_reverse_created_reversal', (
  SELECT fe.id::text
    FROM public.finance_events fe
   WHERE fe.organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
     AND fe.metadata->>'reverses_finance_event_id' = current_setting('test.cv2_ledger_reverse_event')
   ORDER BY fe.created_at ASC, fe.occurred_at ASC
   LIMIT 1
), true);
SELECT set_config('test.cv2_ledger_reverse_event_count_after_first', (
  SELECT COUNT(*)::text
    FROM public.finance_events
   WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
), true);
SELECT set_config('test.cv2_ledger_reverse_decision_count_after_first', (
  SELECT COUNT(*)::text
    FROM public.decision_log
   WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
     AND resource_type = 'finance_event'
), true);
SELECT set_config('test.cv2_ledger_reverse_domain_event_count_after_first', (
  SELECT COUNT(*)::text
    FROM public.domain_events
   WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
     AND resource_type = 'finance_event'
), true);
SELECT set_config('test.cv2_ledger_reverse_attachment_count_after_first', (
  SELECT COUNT(*)::text
    FROM public.settlement_batch_finance_events
   WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
), true);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_ledger_reverse_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT concat(res->>'finance_event_id', ':', res->>'created')
      FROM (
        SELECT api.ui_reverse_finance_event_v1(jsonb_build_object(
          'finance_event_id', current_setting('test.cv2_ledger_reverse_event'),
          'finance_occurred_at', current_setting('test.cv2_ledger_reverse_event_at'),
          'reason', 'allowed ledger reversal reason'
        )) AS res
      ) s
  ),
  current_setting('test.cv2_ledger_reverse_created_reversal') || ':false',
  'same-key ledger reversal retry returns existing reversal without creating'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  current_setting('test.cv2_ledger_reverse_event_count_after_first'),
  'same-key ledger reversal retry appends no extra finance_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_decision_count_after_first'),
  'same-key ledger reversal retry appends no extra decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_domain_event_count_after_first'),
  'same-key ledger reversal retry appends no extra domain_events rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.settlement_batch_finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  current_setting('test.cv2_ledger_reverse_attachment_count_after_first'),
  'same-key ledger reversal retry appends no extra settlement attachments'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_ledger_reverse_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT api.ui_reverse_finance_event_v1(jsonb_build_object(
       'finance_event_id', current_setting('test.cv2_ledger_reverse_event'),
       'finance_occurred_at', current_setting('test.cv2_ledger_reverse_event_at'),
       'reason', 'second ledger reversal must fail',
       'idempotency_key', 'console-v2-ledger-reverse-denied-second-key'
     )) $$,
  '23505',
  NULL,
  'second ledger reversal with different idempotency key is denied'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  current_setting('test.cv2_ledger_reverse_event_count_after_first'),
  'different-key duplicate reversal appends no extra finance_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_decision_count_after_first'),
  'different-key duplicate reversal appends no extra decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid AND resource_type = 'finance_event'),
  current_setting('test.cv2_ledger_reverse_domain_event_count_after_first'),
  'different-key duplicate reversal appends no extra domain_events rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.settlement_batch_finance_events WHERE organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid),
  current_setting('test.cv2_ledger_reverse_attachment_count_after_first'),
  'different-key duplicate reversal appends no extra settlement attachments'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_ledger_reverse_platform_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.ui_reverse_finance_event_v1(jsonb_build_object(
      'organization_id', current_setting('test.cv2_ledger_reverse_org'),
      'finance_event_id', current_setting('test.cv2_ledger_reverse_platform_event'),
      'finance_occurred_at', current_setting('test.cv2_ledger_reverse_platform_event_at'),
      'reason', 'platform active tenant ledger reversal reason'
    ))->>'ok')::boolean
  ),
  'platform operator can reverse active-tenant finance event through api wrapper'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.finance_events fe
     WHERE fe.organization_id = current_setting('test.cv2_ledger_reverse_org')::uuid
       AND fe.event_type = 'adjustment'
       AND fe.direction = 'debit'
       AND fe.amount = 126.75
       AND fe.metadata->>'reversal' = 'true'
       AND fe.metadata->>'reverses_finance_event_id' = current_setting('test.cv2_ledger_reverse_platform_event')
       AND fe.metadata->>'reversal_reason' = 'platform active tenant ledger reversal reason'
  ),
  'platform active-tenant reversal records inverse adjustment in target org'
);

SELECT is(
  (SELECT COUNT(*)::text
     FROM public.finance_events fe
    WHERE fe.organization_id = current_setting('test.cv2_ledger_reverse_platform_home_org')::uuid
      AND fe.metadata->>'reverses_finance_event_id' = current_setting('test.cv2_ledger_reverse_platform_event')),
  '0',
  'platform active-tenant reversal does not write to platform home org'
);

SELECT * FROM finish();
ROLLBACK;
