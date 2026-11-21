-- pgTAP: Console V2 billing write denied-state guard.
-- Ensures read-only billing operators cannot create, edit, send, bulk-send,
-- refund, void, or cancel through either public or api browser RPC paths.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(35);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_client UUID := gen_random_uuid();
  v_limited_user UUID := gen_random_uuid();
  v_ops_user UUID := gen_random_uuid();
  v_update_invoice UUID := gen_random_uuid();
  v_void_invoice UUID := gen_random_uuid();
  v_send_invoice UUID := gen_random_uuid();
  v_refund_invoice UUID := gen_random_uuid();
  v_subscription UUID := gen_random_uuid();
  v_bulk_invoice UUID := gen_random_uuid();
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Billing Denied Org', 'console-v2-billing-denied-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console V2 Billing Denied Client', 'console-v2-billing-denied-' || left(v_client::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_limited_user,
    v_org,
    'console-v2-billing-denied-readonly-' || left(v_limited_user::text, 8) || '@example.com',
    'Console V2 Billing Readonly',
    'account_manager',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_ops_user,
    v_org,
    'console-v2-billing-denied-ops-' || left(v_ops_user::text, 8) || '@example.com',
    'Console V2 Billing Ops',
    'ops_admin',
    'tenant',
    NULL
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoices (
    id, organization_id, client_id, invoice_number, status, currency,
    subtotal, tax_total, total, amount_paid, amount_due,
    period_start_at, period_end_at, issued_at, due_at, paid_at,
    created_by_user_id, idempotency_key, version, metadata
  )
  VALUES
    (v_update_invoice, v_org, v_client, 'CV2-DENIED-UPD', 'draft', 'sar', 100, 15, 115, 0, 115, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', NULL, '2026-06-15T00:00:00Z', NULL, v_ops_user, 'cv2-denied-update', 1, '{}'::jsonb),
    (v_void_invoice, v_org, v_client, 'CV2-DENIED-VOID', 'draft', 'sar', 200, 30, 230, 0, 230, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', NULL, '2026-06-15T00:00:00Z', NULL, v_ops_user, 'cv2-denied-void', 1, '{}'::jsonb),
    (v_send_invoice, v_org, v_client, NULL, 'draft', 'sar', 300, 45, 345, 0, 345, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', NULL, '2026-06-15T00:00:00Z', NULL, v_ops_user, 'cv2-denied-send', 1, '{}'::jsonb),
    (v_refund_invoice, v_org, v_client, 'CV2-DENIED-REFUND', 'paid', 'sar', 400, 60, 460, 460, 0, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', '2026-06-01T00:00:00Z', '2026-06-15T00:00:00Z', '2026-06-10T00:00:00Z', v_ops_user, 'cv2-denied-refund', 1, '{}'::jsonb),
    (v_bulk_invoice, v_org, v_client, NULL, 'draft', 'sar', 500, 75, 575, 0, 575, '2026-05-01T00:00:00Z', '2026-05-31T23:59:59Z', NULL, '2026-06-15T00:00:00Z', NULL, v_ops_user, 'cv2-denied-bulk', 1, '{}'::jsonb)
  ON CONFLICT (id) DO UPDATE
  SET invoice_number = EXCLUDED.invoice_number,
      status = EXCLUDED.status,
      status_reason = NULL,
      currency = EXCLUDED.currency,
      subtotal = EXCLUDED.subtotal,
      tax_total = EXCLUDED.tax_total,
      total = EXCLUDED.total,
      amount_paid = EXCLUDED.amount_paid,
      amount_due = EXCLUDED.amount_due,
      period_start_at = EXCLUDED.period_start_at,
      period_end_at = EXCLUDED.period_end_at,
      issued_at = EXCLUDED.issued_at,
      due_at = EXCLUDED.due_at,
      paid_at = EXCLUDED.paid_at,
      version = EXCLUDED.version,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  INSERT INTO public.subscriptions (
    id, organization_id, client_id, plan_key, status,
    starts_at, ends_at, currency, price_amount,
    idempotency_key, version, metadata, created_by_user_id
  )
  VALUES (
    v_subscription, v_org, v_client, 'cv2_billing_guard', 'active',
    '2026-01-01T00:00:00Z', NULL, 'sar', 100,
    'cv2-denied-subscription', 1, '{}'::jsonb, v_ops_user
  )
  ON CONFLICT (id) DO UPDATE
  SET status = EXCLUDED.status,
      status_reason = NULL,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      currency = EXCLUDED.currency,
      price_amount = EXCLUDED.price_amount,
      version = EXCLUDED.version,
      metadata = EXCLUDED.metadata,
      updated_at = now();

  DELETE FROM public.subscription_events
  WHERE subscription_id = v_subscription;

  DELETE FROM public.decision_log
  WHERE organization_id = v_org
    AND resource_type IN ('billing_invoice', 'subscription');

  DELETE FROM public.domain_events
  WHERE organization_id = v_org
    AND resource_type IN ('billing_invoice', 'subscription');

  PERFORM set_config('test.cv2_billing_denied_org', v_org::text, true);
  PERFORM set_config('test.cv2_billing_denied_client', v_client::text, true);
  PERFORM set_config('test.cv2_billing_denied_limited_user', v_limited_user::text, true);
  PERFORM set_config('test.cv2_billing_denied_ops_user', v_ops_user::text, true);
  PERFORM set_config('test.cv2_billing_denied_update_invoice', v_update_invoice::text, true);
  PERFORM set_config('test.cv2_billing_denied_void_invoice', v_void_invoice::text, true);
  PERFORM set_config('test.cv2_billing_denied_send_invoice', v_send_invoice::text, true);
  PERFORM set_config('test.cv2_billing_denied_refund_invoice', v_refund_invoice::text, true);
  PERFORM set_config('test.cv2_billing_denied_subscription', v_subscription::text, true);
  PERFORM set_config('test.cv2_billing_denied_bulk_invoice', v_bulk_invoice::text, true);

  PERFORM set_config(
    'test.cv2_billing_denied_invoice_count_before',
    (SELECT COUNT(*)::text FROM public.billing_invoices WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_billing_denied_invoice_event_count_before',
    (SELECT COUNT(*)::text FROM public.billing_invoice_events WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_billing_denied_subscription_event_count_before',
    (SELECT COUNT(*)::text FROM public.subscription_events WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_billing_denied_decision_count_before',
    (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = v_org),
    true
  );
  PERFORM set_config(
    'test.cv2_billing_denied_domain_event_count_before',
    (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = v_org),
    true
  );

  EXECUTE 'RESET ROLE';
END $$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_billing_denied_limited_user'), true);
SET LOCAL ROLE authenticated;

SELECT throws_ok(
  $$ SELECT public.create_billing_invoice_v1(jsonb_build_object(
       'client_id', current_setting('test.cv2_billing_denied_client'),
       'currency', 'sar',
       'subtotal', 10,
       'tax_total', 1,
       'idempotency_key', 'cv2-denied-public-create'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.create_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT api.create_billing_invoice_v1(jsonb_build_object(
       'client_id', current_setting('test.cv2_billing_denied_client'),
       'currency', 'sar',
       'subtotal', 10,
       'tax_total', 1,
       'idempotency_key', 'cv2-denied-api-create'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.create_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT public.update_billing_invoice_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_update_invoice'),
       'total', 999
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.update_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT api.update_billing_invoice_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_update_invoice'),
       'total', 999
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.update_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT public.void_billing_invoice_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_void_invoice'),
       'status_reason', 'denied-public-void'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.void_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT api.void_billing_invoice_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_void_invoice'),
       'status_reason', 'denied-api-void'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.void_billing_invoice_v1'
);

SELECT throws_ok(
  $$ SELECT public.billing_invoice_send_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_send_invoice'),
       'invoice_number', 'CV2-DENIED-PUBLIC-SEND'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.billing_invoice_send_v1'
);

SELECT throws_ok(
  $$ SELECT api.billing_invoice_send_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_send_invoice'),
       'invoice_number', 'CV2-DENIED-API-SEND'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.billing_invoice_send_v1'
);

SELECT throws_ok(
  $$ SELECT public.billing_invoice_refund_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_refund_invoice'),
       'refund_amount', 10,
       'refund_reason', 'denied-public-refund'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.billing_invoice_refund_v1'
);

SELECT throws_ok(
  $$ SELECT api.billing_invoice_refund_v1(jsonb_build_object(
       'billing_invoice_id', current_setting('test.cv2_billing_denied_refund_invoice'),
       'refund_amount', 10,
       'refund_reason', 'denied-api-refund'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.billing_invoice_refund_v1'
);

SELECT throws_ok(
  $$ SELECT public.cancel_subscription_v1(jsonb_build_object(
       'subscription_id', current_setting('test.cv2_billing_denied_subscription'),
       'cancellation_reason', 'denied-public-cancel'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.cancel_subscription_v1'
);

SELECT throws_ok(
  $$ SELECT api.cancel_subscription_v1(jsonb_build_object(
       'subscription_id', current_setting('test.cv2_billing_denied_subscription'),
       'cancellation_reason', 'denied-api-cancel'
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.cancel_subscription_v1'
);

SELECT throws_ok(
  $$ SELECT public.ui_bulk_billing_invoice_send_v1(jsonb_build_object(
       'billing_invoice_ids', jsonb_build_array(current_setting('test.cv2_billing_denied_bulk_invoice')),
       'invoice_numbers', jsonb_build_object(current_setting('test.cv2_billing_denied_bulk_invoice'), 'CV2-DENIED-PUBLIC-BULK')
     )) $$,
  '42501',
  NULL,
  'read-only operator denied public.ui_bulk_billing_invoice_send_v1'
);

SELECT throws_ok(
  $$ SELECT api.ui_bulk_billing_invoice_send_v1(jsonb_build_object(
       'billing_invoice_ids', jsonb_build_array(current_setting('test.cv2_billing_denied_bulk_invoice')),
       'invoice_numbers', jsonb_build_object(current_setting('test.cv2_billing_denied_bulk_invoice'), 'CV2-DENIED-API-BULK')
     )) $$,
  '42501',
  NULL,
  'read-only operator denied api.ui_bulk_billing_invoice_send_v1'
);

RESET ROLE;

SELECT is(
  (SELECT COUNT(*)::text FROM public.billing_invoices WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  current_setting('test.cv2_billing_denied_invoice_count_before'),
  'denied billing writes do not create extra billing_invoices'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'total', total, 'amount_due', amount_due, 'metadata', metadata)::text
     FROM public.billing_invoices
    WHERE id = current_setting('test.cv2_billing_denied_update_invoice')::uuid),
  jsonb_build_object('status', 'draft', 'version', 1, 'total', 115::numeric, 'amount_due', 115::numeric, 'metadata', '{}'::jsonb)::text,
  'denied update leaves draft invoice unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'status_reason', status_reason, 'metadata', metadata)::text
     FROM public.billing_invoices
    WHERE id = current_setting('test.cv2_billing_denied_void_invoice')::uuid),
  jsonb_build_object('status', 'draft', 'version', 1, 'status_reason', NULL, 'metadata', '{}'::jsonb)::text,
  'denied void leaves draft invoice unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'invoice_number', invoice_number, 'issued_at', issued_at, 'metadata', metadata)::text
     FROM public.billing_invoices
    WHERE id = current_setting('test.cv2_billing_denied_send_invoice')::uuid),
  jsonb_build_object('status', 'draft', 'version', 1, 'invoice_number', NULL, 'issued_at', NULL, 'metadata', '{}'::jsonb)::text,
  'denied send leaves draft invoice unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'amount_paid', amount_paid, 'amount_due', amount_due, 'status_reason', status_reason, 'metadata', metadata)::text
     FROM public.billing_invoices
    WHERE id = current_setting('test.cv2_billing_denied_refund_invoice')::uuid),
  jsonb_build_object('status', 'paid', 'version', 1, 'amount_paid', 460::numeric, 'amount_due', 0::numeric, 'status_reason', NULL, 'metadata', '{}'::jsonb)::text,
  'denied refund leaves paid invoice unchanged'
);

SELECT is(
  (SELECT jsonb_build_object('status', status, 'version', version, 'status_reason', status_reason, 'ends_at', ends_at, 'metadata', metadata)::text
     FROM public.subscriptions
    WHERE id = current_setting('test.cv2_billing_denied_subscription')::uuid),
  jsonb_build_object('status', 'active', 'version', 1, 'status_reason', NULL, 'ends_at', NULL, 'metadata', '{}'::jsonb)::text,
  'denied cancel leaves subscription unchanged'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.billing_invoice_events WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  current_setting('test.cv2_billing_denied_invoice_event_count_before'),
  'denied billing writes do not append billing_invoice_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.subscription_events WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  current_setting('test.cv2_billing_denied_subscription_event_count_before'),
  'denied billing writes do not append subscription_events'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.decision_log WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  current_setting('test.cv2_billing_denied_decision_count_before'),
  'denied billing writes do not append decision_log rows'
);

SELECT is(
  (SELECT COUNT(*)::text FROM public.domain_events WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  current_setting('test.cv2_billing_denied_domain_event_count_before'),
  'denied billing writes do not append domain_events'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.cv2_billing_denied_ops_user'), true);
SET LOCAL ROLE authenticated;

SELECT ok(
  (
    SELECT (api.create_billing_invoice_v1(jsonb_build_object(
      'client_id', current_setting('test.cv2_billing_denied_client'),
      'currency', 'sar',
      'subtotal', 10,
      'tax_total', 1,
      'idempotency_key', 'cv2-allowed-api-create'
    ))->>'ok')::boolean
  ),
  'ops operator can create billing invoice through api wrapper'
);

SELECT ok(
  (
    SELECT (api.update_billing_invoice_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.cv2_billing_denied_update_invoice'),
      'total', 125
    ))->>'ok')::boolean
  ),
  'ops operator can update draft billing invoice through api wrapper'
);

SELECT ok(
  (
    SELECT (api.void_billing_invoice_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.cv2_billing_denied_void_invoice'),
      'status_reason', 'allowed-api-void'
    ))->>'ok')::boolean
  ),
  'ops operator can void draft billing invoice through api wrapper'
);

SELECT ok(
  (
    SELECT (api.billing_invoice_send_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.cv2_billing_denied_send_invoice'),
      'invoice_number', 'CV2-ALLOWED-SEND'
    ))->>'ok')::boolean
  ),
  'ops operator can send billing invoice through api wrapper'
);

SELECT ok(
  (
    SELECT (api.billing_invoice_refund_v1(jsonb_build_object(
      'billing_invoice_id', current_setting('test.cv2_billing_denied_refund_invoice'),
      'refund_amount', 10,
      'refund_reason', 'allowed-api-refund'
    ))->>'ok')::boolean
  ),
  'ops operator can refund billing invoice through api wrapper'
);

SELECT ok(
  (
    SELECT (api.cancel_subscription_v1(jsonb_build_object(
      'subscription_id', current_setting('test.cv2_billing_denied_subscription'),
      'cancellation_reason', 'allowed-api-cancel'
    ))->>'ok')::boolean
  ),
  'ops operator can cancel subscription through api wrapper'
);

SELECT ok(
  (
    SELECT (api.ui_bulk_billing_invoice_send_v1(jsonb_build_object(
      'billing_invoice_ids', jsonb_build_array(current_setting('test.cv2_billing_denied_bulk_invoice')),
      'invoice_numbers', jsonb_build_object(current_setting('test.cv2_billing_denied_bulk_invoice'), 'CV2-ALLOWED-BULK')
    ))->>'ok')::boolean
  ),
  'ops operator can bulk-send billing invoices through api wrapper'
);

RESET ROLE;

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_billing_denied_invoice_event_count_before')::integer + 6
     FROM public.billing_invoice_events
    WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  'allowed billing writes append canonical billing_invoice_events'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_billing_denied_subscription_event_count_before')::integer + 1
     FROM public.subscription_events
    WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  'allowed subscription cancel appends canonical subscription_events'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_billing_denied_decision_count_before')::integer + 7
     FROM public.decision_log
    WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  'allowed billing writes append decision_log rows'
);

SELECT ok(
  (SELECT COUNT(*) >= current_setting('test.cv2_billing_denied_domain_event_count_before')::integer + 7
     FROM public.domain_events
    WHERE organization_id = current_setting('test.cv2_billing_denied_org')::uuid),
  'allowed billing writes append domain_events'
);

SELECT * FROM finish();
ROLLBACK;
