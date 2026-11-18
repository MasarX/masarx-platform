-- pgTAP: Console V2 subscription cancel readback and lineage contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(11);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000c5b0';
  v_client UUID := '00000000-0000-0000-0000-00000000c5b1';
  v_subscription UUID := '00000000-0000-0000-0000-00000000c5b2';
  v_ops_admin UUID := '00000000-0000-0000-0000-00000000c5b3';
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Cancel Subscription Org', 'console-cancel-sub-org')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Cancel Subscription Client', 'console-cancel-sub-client')
  ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_admin,
    v_org,
    'console-cancel-sub-ops@example.com',
    'Console Cancel Subscription Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        user_type = EXCLUDED.user_type,
        access_scope_type = EXCLUDED.access_scope_type;

  INSERT INTO public.subscriptions (
    id, organization_id, client_id, plan_key, status,
    starts_at, ends_at, currency, price_amount, status_reason, metadata, version
  )
  VALUES (
    v_subscription,
    v_org,
    v_client,
    'console_cancel_monthly',
    'active',
    '2026-04-01T00:00:00Z',
    NULL,
    'sar',
    115,
    NULL,
    jsonb_build_object('plan_label', 'Console cancel monthly'),
    1
  )
  ON CONFLICT (id) DO UPDATE
    SET status = 'active',
        ends_at = NULL,
        status_reason = NULL,
        version = 1;

  PERFORM set_config('request.jwt.claim.sub', v_ops_admin::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT public.cancel_subscription_v1(jsonb_build_object(
    'subscription_id', v_subscription,
    'cancellation_reason', 'pgtap visible cancel reason'
  ))
  INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM set_config('test.cancel_subscription_id', v_subscription::text, true);
  PERFORM set_config('test.cancel_subscription_correlation', v_result->>'correlation_id', true);
END $$;

SELECT is(
  (SELECT status FROM public.subscriptions WHERE id = current_setting('test.cancel_subscription_id')::uuid),
  'canceled',
  'subscription row is canceled'
);

SELECT is(
  (SELECT status_reason FROM public.subscriptions WHERE id = current_setting('test.cancel_subscription_id')::uuid),
  'pgtap visible cancel reason',
  'subscription row stores cancellation reason'
);

SELECT ok(
  (SELECT ends_at IS NOT NULL FROM public.subscriptions WHERE id = current_setting('test.cancel_subscription_id')::uuid),
  'subscription row stores cancellation timestamp'
);

SELECT is(
  (SELECT version FROM public.subscriptions WHERE id = current_setting('test.cancel_subscription_id')::uuid),
  2,
  'subscription version increments'
);

SELECT is(
  (SELECT event_type FROM public.subscription_events WHERE subscription_id = current_setting('test.cancel_subscription_id')::uuid ORDER BY created_at DESC, id DESC LIMIT 1),
  'subscription.canceled',
  'subscription event is appended'
);

SELECT is(
  (SELECT payload->>'cancellation_reason' FROM public.subscription_events WHERE subscription_id = current_setting('test.cancel_subscription_id')::uuid ORDER BY created_at DESC, id DESC LIMIT 1),
  'pgtap visible cancel reason',
  'subscription event carries cancellation reason'
);

SELECT ok(
  current_setting('test.cancel_subscription_correlation')::uuid IS NOT NULL,
  'cancel_subscription_v1 returns UUID correlation'
);

SELECT is(
  (SELECT decision_outcome FROM public.decision_log WHERE resource_type = 'subscription' AND resource_id = current_setting('test.cancel_subscription_id')::uuid AND correlation_id = current_setting('test.cancel_subscription_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  'canceled',
  'decision log is correlated'
);

SELECT is(
  (SELECT event_type FROM public.domain_events WHERE resource_type = 'subscription' AND resource_id = current_setting('test.cancel_subscription_id')::uuid AND correlation_id = current_setting('test.cancel_subscription_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  'subscription.canceled',
  'domain event is correlated'
);

SELECT is(
  (SELECT payload->>'new_status' FROM public.domain_events WHERE resource_type = 'subscription' AND resource_id = current_setting('test.cancel_subscription_id')::uuid AND correlation_id = current_setting('test.cancel_subscription_correlation')::uuid ORDER BY created_at DESC LIMIT 1),
  'canceled',
  'domain event payload exposes new status'
);

SELECT is(
  (
    SELECT lv.metadata->>'lifecycle'
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'subscription_status'
      AND lv.value = 'canceled'
    LIMIT 1
  ),
  'terminal',
  'subscription_status canceled is terminal in row-driven lookup metadata'
);

SELECT * FROM finish();
ROLLBACK;
