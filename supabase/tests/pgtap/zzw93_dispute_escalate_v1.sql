-- pgTAP: public.dispute_escalate_v1 contract (allowed/denied/transition/RLS)
-- W9-3 — residual FINANCE gap closure (escalate path).
-- Companion to zzw84_dispute_acknowledge_v1.sql; same fixture pattern.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

-- Fixtures: an open marketplace_dispute between two orgs + an under_review one.
DO $$
DECLARE
  v_org1 UUID := '00000000-0000-0000-0000-00000000d930';
  v_org2 UUID := '00000000-0000-0000-0000-00000000d931';
  v_dispute_open UUID := '00000000-0000-0000-0000-00000000d932';
  v_dispute_review UUID := '00000000-0000-0000-0000-00000000d933';
  v_dispute_resolved UUID := '00000000-0000-0000-0000-00000000d934';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000d935';
  v_sender_user UUID := '00000000-0000-0000-0000-00000000d936';
  v_client UUID := '00000000-0000-0000-0000-00000000d937';
  v_sender_scope UUID := '00000000-0000-0000-0000-00000000d938';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'W93 Esc Org A', 'w93-esc-a-' || left(v_org1::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org2, 'W93 Esc Org B', 'w93-esc-b-' || left(v_org2::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops_admin, v_org1, 'w93-esc-ops-' || left(v_ops_admin::text, 8) || '@example.com',
          'W93 Esc Ops Admin', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org1, 'W93 Esc Client', 'w93-esc-client-' || left(v_client::text, 8), 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, brand_name, status)
  VALUES (v_sender_scope, v_client, 'W93 Esc Sender Scope', 'W93 Esc Sender Scope', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_sender_user, v_org1, 'w93-esc-sender-' || left(v_sender_user::text, 8) || '@example.com',
          'W93 Esc Sender', 'sender_user', 'sender', v_sender_scope)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description
  )
  VALUES (
    v_dispute_open, v_org1, v_org2,
    'open', 'general', 'W93 Esc Dispute (open)', 'pgtap fixture escalate (open)'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description
  )
  VALUES (
    v_dispute_review, v_org1, v_org2,
    'under_review', 'general', 'W93 Esc Dispute (under_review)', 'pgtap fixture escalate (review)'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description, resolution
  )
  VALUES (
    v_dispute_resolved, v_org1, v_org2,
    'resolved', 'general', 'W93 Esc Dispute (resolved)', 'pgtap fixture escalate (resolved)', 'credit'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.w93_org1', v_org1::text, true);
  PERFORM set_config('test.w93_dispute_open', v_dispute_open::text, true);
  PERFORM set_config('test.w93_dispute_review', v_dispute_review::text, true);
  PERFORM set_config('test.w93_dispute_resolved', v_dispute_resolved::text, true);
  PERFORM set_config('test.w93_ops_admin', v_ops_admin::text, true);
  PERFORM set_config('test.w93_sender_user', v_sender_user::text, true);

  EXECUTE 'RESET ROLE';
END $$;

-- 1) Allowed: ops_admin can escalate an open dispute (open -> under_review)
SELECT set_config('request.jwt.claim.sub', current_setting('test.w93_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT is(
  (
    SELECT (public.dispute_escalate_v1(jsonb_build_object(
      'dispute_id', current_setting('test.w93_dispute_open'),
      'escalation_reason', 'Operator-initiated escalation'
    ))->>'status')
  ),
  'under_review',
  'ops_admin can dispute_escalate_v1 (open -> under_review)'
);

-- 2) Escalation increments count: re-escalating an already-under_review dispute keeps status, increments count
SELECT is(
  (
    SELECT (public.dispute_escalate_v1(jsonb_build_object(
      'dispute_id', current_setting('test.w93_dispute_open'),
      'escalation_reason', 'Second escalation'
    ))->>'escalation_count')
  ),
  '2',
  're-escalating an under_review dispute increments escalation_count without status change'
);

-- 3) Terminal status rejection: cannot escalate resolved disputes
SELECT throws_ok(
  $$ SELECT public.dispute_escalate_v1(jsonb_build_object(
       'dispute_id', current_setting('test.w93_dispute_resolved'),
       'escalation_reason', 'too late'
     )) $$,
  '22023',
  NULL,
  'cannot escalate dispute in terminal status (resolved)'
);
RESET ROLE;

-- 4) Denied: sender_user lacks disputes.write
SELECT set_config('request.jwt.claim.sub', current_setting('test.w93_sender_user'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.dispute_escalate_v1(jsonb_build_object(
       'dispute_id', current_setting('test.w93_dispute_review'),
       'escalation_reason', 'denied path'
     )) $$,
  '42501',
  NULL,
  'sender_user denied dispute_escalate_v1 (disputes.write missing)'
);
RESET ROLE;

-- 5) Required field: escalation_reason must be non-empty
SELECT set_config('request.jwt.claim.sub', current_setting('test.w93_ops_admin'), true);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.dispute_escalate_v1(jsonb_build_object(
       'dispute_id', current_setting('test.w93_dispute_review'),
       'escalation_reason', '   '
     )) $$,
  '23502',
  NULL,
  'dispute_escalate_v1 requires non-empty escalation_reason'
);
RESET ROLE;

-- 6) RLS isolation: marketplace_disputes service-only writes
SELECT ok(
  NOT has_table_privilege('authenticated', 'public.marketplace_disputes', 'update'),
  'authenticated has no direct UPDATE on marketplace_disputes (RLS write goes through SECURITY DEFINER RPC)'
);

SELECT * FROM finish();
ROLLBACK;
