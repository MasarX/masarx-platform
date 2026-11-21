-- pgTAP: Console V2 settlement write denied-state guard.
-- Ensures read-only settlement operators cannot create, transition, approve,
-- or reject settlement batches through either public or api browser RPC paths.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(22);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_branch UUID := gen_random_uuid();
  v_limited_user UUID := gen_random_uuid();
  v_ops_user UUID := gen_random_uuid();
  v_transition_batch UUID := gen_random_uuid();
  v_apply_batch UUID := gen_random_uuid();
  v_reject_batch UUID := gen_random_uuid();
  v_api_transition_batch UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Settlement Denied Org', 'console-v2-settlement-denied-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name)
  VALUES (v_branch, v_org, 'cv2-sd-' || left(v_branch::text, 8), 'Console V2 Settlement Denied Branch')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited_user,
    v_org,
    'console-v2-settlement-denied-readonly-' || left(v_limited_user::text, 8) || '@example.com',
    'Console V2 Settlement Readonly',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_user,
    v_org,
    'console-v2-settlement-denied-ops-' || left(v_ops_user::text, 8) || '@example.com',
    'Console V2 Settlement Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.settlement_batches (
    id, organization_id, kind, scope_type, branch_id,
    subject_type, subject_id, status, version, metadata
  )
  VALUES
    (v_transition_batch, v_org, 'cod', 'branch_day', v_branch, 'branch', v_branch, 'open', 1, '{}'::jsonb),
    (v_apply_batch, v_org, 'cod', 'branch_day', v_branch, 'branch', v_branch, 'locked', 1, '{}'::jsonb),
    (v_reject_batch, v_org, 'cod', 'branch_day', v_branch, 'branch', v_branch, 'locked', 1, '{}'::jsonb),
    (v_api_transition_batch, v_org, 'cod', 'branch_day', v_branch, 'branch', v_branch, 'open', 1, '{}'::jsonb)
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      status_reason = NULL,
      version = EXCLUDED.version,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  DELETE FROM public.decision_log
  WHERE organization_id = v_org
    AND resource_type = 'settlement_batch'
    AND resource_id IN (v_transition_batch, v_apply_batch, v_reject_batch, v_api_transition_batch);

  DELETE FROM public.domain_events
  WHERE organization_id = v_org
    AND resource_type = 'settlement_batch'
    AND resource_id IN (v_transition_batch, v_apply_batch, v_reject_batch, v_api_transition_batch);

  PERFORM set_config('test.cv2_settlement_denied_org', v_org::text, true);
  PERFORM set_config('test.cv2_settlement_denied_branch', v_branch::text, true);
  PERFORM set_config('test.cv2_settlement_denied_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_settlement_denied_ops_user', v_ops_user::text, true);
  PERFORM set_config('test.cv2_settlement_denied_transition_batch', v_transition_batch::text, true);
  PERFORM set_config('test.cv2_settlement_denied_apply_batch', v_apply_batch::text, true);
  PERFORM set_config('test.cv2_settlement_denied_reject_batch', v_reject_batch::text, true);
  PERFORM set_config('test.cv2_settlement_denied_api_transition_batch', v_api_transition_batch::text, true);

  PERFORM set_config(
    'test.cv2_settlement_denied_batch_count_before',
    (SELECT COUNT(*)::text FROM public.settlement_batches WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_settlement_denied_event_count_before',
    (SELECT COUNT(*)::text FROM public.settlement_events WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_settlement_denied_finance_event_count_before',
    (SELECT COUNT(*)::text FROM public.settlement_batch_finance_events WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_settlement_denied_decision_count_before',
    (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_settlement_denied_domain_event_count_before',
    (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = v_org),
    true
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_settlement_denied_limited_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.ui_create_settlement_batch_v1(jsonb_build_object(
       'kind', 'cod',
       'scope_type', 'branch_day',
       'branch_id', current_setting('test.cv2_settlement_denied_branch'),
       'window_start_at', '2026-05-16T00:00:00Z',
       'window_end_at', '2026-05-16T23:59:59Z',
       'idempotency_key', 'pgtap-settlement-denied-public-create'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_create_settlement_batch_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_create_settlement_batch_v1(jsonb_build_object(
       'kind', 'cod',
       'scope_type', 'branch_day',
       'branch_id', current_setting('test.cv2_settlement_denied_branch'),
       'window_start_at', '2026-05-16T00:00:00Z',
       'window_end_at', '2026-05-16T23:59:59Z',
       'idempotency_key', 'pgtap-settlement-denied-api-create'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_create_settlement_batch_v1'
);

SELECT throws_ok(
  $$ SELECT public.ui_transition_settlement_batch_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_transition_batch'),
       'to_status', 'locked',
       'payload', jsonb_build_object('source', 'pgtap-denied-public-transition'),
       'idempotency_key', 'pgtap-settlement-denied-public-transition'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_transition_settlement_batch_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_transition_settlement_batch_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_api_transition_batch'),
       'to_status', 'locked',
       'payload', jsonb_build_object('source', 'pgtap-denied-api-transition'),
       'idempotency_key', 'pgtap-settlement-denied-api-transition'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_transition_settlement_batch_v1'
);

SELECT throws_ok(
  $$ SELECT public.apply_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_apply_batch'),
       'approval_notes', 'denied-public-apply'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.apply_settlement_v1'
);

SELECT throws_ok(
  $$ SELECT api.apply_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_apply_batch'),
       'approval_notes', 'denied-api-apply'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.apply_settlement_v1'
);

SELECT throws_ok(
  $$ SELECT public.reject_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_reject_batch'),
       'rejection_reason', 'denied-public-reject'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.reject_settlement_v1'
);

SELECT throws_ok(
  $$ SELECT api.reject_settlement_v1(jsonb_build_object(
       'settlement_batch_id', current_setting('test.cv2_settlement_denied_reject_batch'),
       'rejection_reason', 'denied-api-reject'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.reject_settlement_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.settlement_batches WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  current_setting('test.cv2_settlement_denied_batch_count_before'),
  'denied settlement writes do not create extra settlement_batches'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'status_reason', status_reason, 'metadata', metadata)::text
     FROM public.settlement_batches
    WHERE id = current_setting('test.cv2_settlement_denied_transition_batch')::uuid),
  jsonb_build_object('status', 'open', 'version', 1, 'status_reason', NULL, 'metadata', '{}'::jsonb)::text,
  'denied transition leaves target batch unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'status_reason', status_reason, 'metadata', metadata)::text
     FROM public.settlement_batches
    WHERE id = current_setting('test.cv2_settlement_denied_apply_batch')::uuid),
  jsonb_build_object('status', 'locked', 'version', 1, 'status_reason', NULL, 'metadata', '{}'::jsonb)::text,
  'denied approve leaves target batch unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'status_reason', status_reason, 'metadata', metadata)::text
     FROM public.settlement_batches
    WHERE id = current_setting('test.cv2_settlement_denied_reject_batch')::uuid),
  jsonb_build_object('status', 'locked', 'version', 1, 'status_reason', NULL, 'metadata', '{}'::jsonb)::text,
  'denied reject leaves target batch unchanged'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.settlement_events WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  current_setting('test.cv2_settlement_denied_event_count_before'),
  'denied settlement writes do not append settlement_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.settlement_batch_finance_events WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  current_setting('test.cv2_settlement_denied_finance_event_count_before'),
  'denied settlement writes do not append settlement_batch_finance_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  current_setting('test.cv2_settlement_denied_decision_count_before'),
  'denied settlement writes do not append decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  current_setting('test.cv2_settlement_denied_domain_event_count_before'),
  'denied settlement writes do not append domain_events'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_settlement_denied_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.ui_create_settlement_batch_v1(jsonb_build_object(
      'kind', 'cod',
      'scope_type', 'branch_day',
      'branch_id', current_setting('test.cv2_settlement_denied_branch'),
      'window_start_at', '2026-05-17T00:00:00Z',
      'window_end_at', '2026-05-17T23:59:59Z',
      'idempotency_key', 'pgtap-settlement-allowed-api-create'
    ))->>'ok')::boolean
  ),
  'ops operator can create settlement through api wrapper'
);

SELECT ok(
  (
    SELECT (api.ui_transition_settlement_batch_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.cv2_settlement_denied_transition_batch'),
      'to_status', 'locked',
      'payload', jsonb_build_object('source', 'pgtap-allowed-api-transition'),
      'idempotency_key', 'pgtap-settlement-allowed-api-transition'
    ))->>'ok')::boolean
  ),
  'ops operator can transition settlement through api wrapper'
);

SELECT ok(
  (
    SELECT (api.apply_settlement_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.cv2_settlement_denied_apply_batch'),
      'approval_notes', 'allowed-api-apply'
    ))->>'ok')::boolean
  ),
  'ops operator can approve settlement through api wrapper'
);

SELECT ok(
  (
    SELECT (api.reject_settlement_v1(jsonb_build_object(
      'settlement_batch_id', current_setting('test.cv2_settlement_denied_reject_batch'),
      'rejection_reason', 'allowed-api-reject'
    ))->>'ok')::boolean
  ),
  'ops operator can reject settlement through api wrapper'
);

RESET ROLE;

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_settlement_denied_event_count_before')::integer + 4
     FROM public.settlement_events
    WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  'allowed settlement writes append canonical settlement_events'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_settlement_denied_decision_count_before')::integer + 4
     FROM public.decision_log
    WHERE organization_id = current_setting('test.cv2_settlement_denied_org')::uuid),
  'allowed settlement writes append decision_log rows'
);

SELECT * FROM finish();
ROLLBACK;
