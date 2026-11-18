-- pgTAP: Console V2 dispute write denied-state guard.
-- Ensures read-only finance operators cannot resolve, reject, acknowledge,
-- escalate, or bulk-mutate disputes through public/api RPC paths.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(25);

DO $$
DECLARE
  v_org_a UUID := '00000000-0000-0000-0000-00000000d9a0';
  v_org_b UUID := '00000000-0000-0000-0000-00000000d9a1';
  v_limited_user UUID := '00000000-0000-0000-0000-00000000d9a2';
  v_ops_user UUID := '00000000-0000-0000-0000-00000000d9a3';
  v_resolve_dispute UUID := '00000000-0000-0000-0000-00000000d9a4';
  v_reject_dispute UUID := '00000000-0000-0000-0000-00000000d9a5';
  v_ack_dispute UUID := '00000000-0000-0000-0000-00000000d9a6';
  v_escalate_dispute UUID := '00000000-0000-0000-0000-00000000d9a7';
  v_bulk_dispute UUID := '00000000-0000-0000-0000-00000000d9a8';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org_a, 'Console V2 Dispute Denied Org A', 'console-v2-dispute-denied-a-' || left(v_org_a::text, 8)),
    (v_org_b, 'Console V2 Dispute Denied Org B', 'console-v2-dispute-denied-b-' || left(v_org_b::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited_user,
    v_org_a,
    'console-v2-dispute-readonly-' || left(v_limited_user::text, 8) || '@example.com',
    'Console V2 Dispute Readonly',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_user,
    v_org_a,
    'console-v2-dispute-ops-' || left(v_ops_user::text, 8) || '@example.com',
    'Console V2 Dispute Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.marketplace_disputes (
    id, opened_by_organization_id, counterparty_organization_id,
    status, category, title, description, resolution, resolved_at,
    resolved_by_user_id, metadata
  )
  VALUES
    (v_resolve_dispute, v_org_a, v_org_b, 'open', 'general', 'Denied Resolve Dispute', 'pgtap fixture', NULL, NULL, NULL, '{"fixture":"resolve"}'::jsonb),
    (v_reject_dispute, v_org_a, v_org_b, 'open', 'general', 'Denied Reject Dispute', 'pgtap fixture', NULL, NULL, NULL, '{"fixture":"reject"}'::jsonb),
    (v_ack_dispute, v_org_a, v_org_b, 'open', 'general', 'Denied Acknowledge Dispute', 'pgtap fixture', NULL, NULL, NULL, '{"fixture":"ack"}'::jsonb),
    (v_escalate_dispute, v_org_a, v_org_b, 'open', 'general', 'Denied Escalate Dispute', 'pgtap fixture', NULL, NULL, NULL, '{"fixture":"escalate"}'::jsonb),
    (v_bulk_dispute, v_org_a, v_org_b, 'open', 'general', 'Denied Bulk Dispute', 'pgtap fixture', NULL, NULL, NULL, '{"fixture":"bulk"}'::jsonb)
  ON CONFLICT (id) DO UPDATE
  SET opened_by_organization_id = EXCLUDED.opened_by_organization_id,
      counterparty_organization_id = EXCLUDED.counterparty_organization_id,
      status = EXCLUDED.status,
      category = EXCLUDED.category,
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      resolution = NULL,
      resolved_at = NULL,
      resolved_by_user_id = NULL,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  DELETE FROM public.decision_log
  WHERE organization_id = v_org_a
    AND resource_type = 'marketplace_dispute'
    AND resource_id IN (v_resolve_dispute, v_reject_dispute, v_ack_dispute, v_escalate_dispute, v_bulk_dispute);

  DELETE FROM public.domain_events
  WHERE organization_id = v_org_a
    AND resource_type = 'marketplace_dispute'
    AND resource_id IN (v_resolve_dispute, v_reject_dispute, v_ack_dispute, v_escalate_dispute, v_bulk_dispute);

  PERFORM set_config('test.cv2_dispute_org', v_org_a::text, true);
  PERFORM set_config('test.cv2_dispute_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_dispute_ops_user', v_ops_user::text, true);
  PERFORM set_config('test.cv2_dispute_resolve', v_resolve_dispute::text, true);
  PERFORM set_config('test.cv2_dispute_reject', v_reject_dispute::text, true);
  PERFORM set_config('test.cv2_dispute_ack', v_ack_dispute::text, true);
  PERFORM set_config('test.cv2_dispute_escalate', v_escalate_dispute::text, true);
  PERFORM set_config('test.cv2_dispute_bulk', v_bulk_dispute::text, true);
  PERFORM set_config(
    'test.cv2_dispute_count_before',
    (SELECT COUNT(*)::text FROM public.marketplace_disputes WHERE opened_by_organization_id = v_org_a),
    true
  );
  PERFORM set_config(
    'test.cv2_dispute_decision_count_before',
    (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = v_org_a AND resource_type = 'marketplace_dispute'),
    true
  );
  PERFORM set_config(
    'test.cv2_dispute_domain_event_count_before',
    (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = v_org_a AND resource_type = 'marketplace_dispute'),
    true
  );

  PERFORM set_config('test.cv2_dispute_state_resolve_before', (
    SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
    FROM public.marketplace_disputes WHERE id = v_resolve_dispute
  ), true);
  PERFORM set_config('test.cv2_dispute_state_reject_before', (
    SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
    FROM public.marketplace_disputes WHERE id = v_reject_dispute
  ), true);
  PERFORM set_config('test.cv2_dispute_state_ack_before', (
    SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
    FROM public.marketplace_disputes WHERE id = v_ack_dispute
  ), true);
  PERFORM set_config('test.cv2_dispute_state_escalate_before', (
    SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
    FROM public.marketplace_disputes WHERE id = v_escalate_dispute
  ), true);
  PERFORM set_config('test.cv2_dispute_state_bulk_before', (
    SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
    FROM public.marketplace_disputes WHERE id = v_bulk_dispute
  ), true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_dispute_limited_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.dispute_resolve_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_resolve'),
       'resolution', 'denied-public-resolve'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.dispute_resolve_v1'
);

SELECT throws_ok(
  $$ SELECT api.dispute_resolve_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_resolve'),
       'resolution', 'denied-api-resolve'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.dispute_resolve_v1'
);

SELECT throws_ok(
  $$ SELECT public.dispute_reject_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_reject'),
       'rejection_reason', 'denied-public-reject'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.dispute_reject_v1'
);

SELECT throws_ok(
  $$ SELECT api.dispute_reject_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_reject'),
       'rejection_reason', 'denied-api-reject'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.dispute_reject_v1'
);

SELECT throws_ok(
  $$ SELECT public.dispute_acknowledge_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_ack')
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.dispute_acknowledge_v1'
);

SELECT throws_ok(
  $$ SELECT api.dispute_acknowledge_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_ack')
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.dispute_acknowledge_v1'
);

SELECT throws_ok(
  $$ SELECT public.dispute_escalate_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_escalate'),
       'escalation_reason', 'denied-public-escalate'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.dispute_escalate_v1'
);

SELECT throws_ok(
  $$ SELECT api.dispute_escalate_v1(jsonb_build_object(
       'dispute_id', current_setting('test.cv2_dispute_escalate'),
       'escalation_reason', 'denied-api-escalate'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.dispute_escalate_v1'
);

SELECT throws_ok(
  $$ SELECT public.ui_bulk_dispute_action_v1(jsonb_build_object(
       'dispute_ids', jsonb_build_array(current_setting('test.cv2_dispute_bulk')),
       'operation', 'acknowledge'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_bulk_dispute_action_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_bulk_dispute_action_v1(jsonb_build_object(
       'dispute_ids', jsonb_build_array(current_setting('test.cv2_dispute_bulk')),
       'operation', 'acknowledge'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_bulk_dispute_action_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.marketplace_disputes WHERE opened_by_organization_id = current_setting('test.cv2_dispute_org')::uuid),
  current_setting('test.cv2_dispute_count_before'),
  'denied dispute writes do not create or delete marketplace_disputes'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_dispute_org')::uuid AND resource_type = 'marketplace_dispute'),
  current_setting('test.cv2_dispute_decision_count_before'),
  'denied dispute writes append no decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_dispute_org')::uuid AND resource_type = 'marketplace_dispute'),
  current_setting('test.cv2_dispute_domain_event_count_before'),
  'denied dispute writes append no domain_events rows'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
   FROM public.marketplace_disputes WHERE id = current_setting('test.cv2_dispute_resolve')::uuid),
  current_setting('test.cv2_dispute_state_resolve_before'),
  'denied resolve leaves dispute state unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
   FROM public.marketplace_disputes WHERE id = current_setting('test.cv2_dispute_reject')::uuid),
  current_setting('test.cv2_dispute_state_reject_before'),
  'denied reject leaves dispute state unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
   FROM public.marketplace_disputes WHERE id = current_setting('test.cv2_dispute_ack')::uuid),
  current_setting('test.cv2_dispute_state_ack_before'),
  'denied acknowledge leaves dispute state unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
   FROM public.marketplace_disputes WHERE id = current_setting('test.cv2_dispute_escalate')::uuid),
  current_setting('test.cv2_dispute_state_escalate_before'),
  'denied escalate leaves dispute state unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'resolution', resolution, 'resolved_at', resolved_at, 'resolved_by_user_id', resolved_by_user_id, 'metadata', metadata)::text
   FROM public.marketplace_disputes WHERE id = current_setting('test.cv2_dispute_bulk')::uuid),
  current_setting('test.cv2_dispute_state_bulk_before'),
  'denied bulk action leaves dispute state unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_dispute_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT is(
  (api.dispute_resolve_v1(jsonb_build_object(
    'dispute_id', current_setting('test.cv2_dispute_resolve'),
    'resolution', 'accepted'
  ))->>'status'),
  'resolved',
  'ops operator can resolve dispute through api wrapper'
);

SELECT is(
  (api.dispute_reject_v1(jsonb_build_object(
    'dispute_id', current_setting('test.cv2_dispute_reject'),
    'rejection_reason', 'not valid'
  ))->>'status'),
  'rejected',
  'ops operator can reject dispute through api wrapper'
);

SELECT is(
  (api.dispute_acknowledge_v1(jsonb_build_object(
    'dispute_id', current_setting('test.cv2_dispute_ack')
  ))->>'status'),
  'under_review',
  'ops operator can acknowledge dispute through api wrapper'
);

SELECT is(
  (api.dispute_escalate_v1(jsonb_build_object(
    'dispute_id', current_setting('test.cv2_dispute_escalate'),
    'escalation_reason', 'needs review'
  ))->>'status'),
  'under_review',
  'ops operator can escalate dispute through api wrapper'
);

SELECT is(
  (api.ui_bulk_dispute_action_v1(jsonb_build_object(
    'dispute_ids', jsonb_build_array(current_setting('test.cv2_dispute_bulk')),
    'operation', 'acknowledge'
  ))->>'succeeded_count'),
  '1',
  'ops operator can bulk acknowledge dispute through api wrapper'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_dispute_org')::uuid AND resource_type = 'marketplace_dispute'),
  ((current_setting('test.cv2_dispute_decision_count_before')::integer + 5)::text),
  'allowed dispute writes append expected decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_dispute_org')::uuid AND resource_type = 'marketplace_dispute'),
  ((current_setting('test.cv2_dispute_domain_event_count_before')::integer + 5)::text),
  'allowed dispute writes append expected domain_events rows'
);

SELECT * FROM finish();
ROLLBACK;
