-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- pgTAP: Last-mile CX structures v1 (tracking sessions, returns, support, feedback, billing, route plans)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(67);

-- 1) Existence + RLS posture
SELECT has_table('public', 'tracking_sessions', 'tracking_sessions table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='tracking_sessions'), 'RLS enabled on tracking_sessions');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='tracking_sessions'), 'tracking_sessions has policies');

SELECT has_table('public', 'returns', 'returns table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='returns'), 'RLS enabled on returns');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='returns'), 'returns has policies');

SELECT has_table('public', 'return_events', 'return_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='return_events'), 'RLS enabled on return_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='return_events'), 'return_events has policies');

SELECT has_table('public', 'support_cases', 'support_cases table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='support_cases'), 'RLS enabled on support_cases');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='support_cases'), 'support_cases has policies');

SELECT has_table('public', 'support_case_events', 'support_case_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='support_case_events'), 'RLS enabled on support_case_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='support_case_events'), 'support_case_events has policies');

SELECT has_table('public', 'support_messages', 'support_messages table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='support_messages'), 'RLS enabled on support_messages');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='support_messages'), 'support_messages has policies');

SELECT has_table('public', 'feedback_events', 'feedback_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='feedback_events'), 'RLS enabled on feedback_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='feedback_events'), 'feedback_events has policies');

SELECT has_table('public', 'route_plans', 'route_plans table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='route_plans'), 'RLS enabled on route_plans');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='route_plans'), 'route_plans has policies');

SELECT has_table('public', 'route_plan_events', 'route_plan_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='route_plan_events'), 'RLS enabled on route_plan_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='route_plan_events'), 'route_plan_events has policies');

SELECT has_table('public', 'billing_invoices', 'billing_invoices table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='billing_invoices'), 'RLS enabled on billing_invoices');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='billing_invoices'), 'billing_invoices has policies');

SELECT has_table('public', 'billing_invoice_lines', 'billing_invoice_lines table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='billing_invoice_lines'), 'RLS enabled on billing_invoice_lines');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='billing_invoice_lines'), 'billing_invoice_lines has policies');

SELECT has_table('public', 'billing_invoice_events', 'billing_invoice_events table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='billing_invoice_events'), 'RLS enabled on billing_invoice_events');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='billing_invoice_events'), 'billing_invoice_events has policies');

SELECT has_column('public', 'route_runs', 'route_plan_id', 'route_runs has route_plan_id');

-- 2) Contracts: table_contracts contains rows
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'tracking_sessions'), 'tracking_sessions registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'returns'), 'returns registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'return_events'), 'return_events registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'support_cases'), 'support_cases registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'support_case_events'), 'support_case_events registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'support_messages'), 'support_messages registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'feedback_events'), 'feedback_events registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'route_plans'), 'route_plans registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'route_plan_events'), 'route_plan_events registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'billing_invoices'), 'billing_invoices registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'billing_invoice_lines'), 'billing_invoice_lines registered in table_contracts');
SELECT ok(EXISTS(SELECT 1 FROM public.table_contracts WHERE table_schema = 'public' AND table_name = 'billing_invoice_events'), 'billing_invoice_events registered in table_contracts');

-- 3) Basic RLS behavior (tenant/client/sender visibility + route_plans tenant-only)
SELECT set_config('test.lm.org_id', '1a100000-0000-0000-0000-000000000001', TRUE);
SELECT set_config('test.lm.branch_id', '1a100000-0000-0000-0000-000000000101', TRUE);
SELECT set_config('test.lm.client_id', '1a100000-0000-0000-0000-000000000201', TRUE);
SELECT set_config('test.lm.sender_id', '1a100000-0000-0000-0000-000000000301', TRUE);
SELECT set_config('test.lm.recipient_id', '1a100000-0000-0000-0000-000000000401', TRUE);
SELECT set_config('test.lm.shipment_id', '1a100000-0000-0000-0000-000000000501', TRUE);
SELECT set_config('test.lm.tenant_user_id', '1a100000-0000-0000-0000-000000000601', TRUE);
SELECT set_config('test.lm.client_user_id', '1a100000-0000-0000-0000-000000000602', TRUE);
SELECT set_config('test.lm.sender_user_id', '1a100000-0000-0000-0000-000000000603', TRUE);
SELECT set_config('test.lm.tracking_session_id', '1a100000-0000-0000-0000-000000000701', TRUE);
SELECT set_config('test.lm.return_id', '1a100000-0000-0000-0000-000000000702', TRUE);
SELECT set_config('test.lm.support_case_id', '1a100000-0000-0000-0000-000000000703', TRUE);
SELECT set_config('test.lm.route_plan_id', '1a100000-0000-0000-0000-000000000704', TRUE);
SELECT set_config('test.lm.invoice_id', '1a100000-0000-0000-0000-000000000705', TRUE);

DO $$
DECLARE
  v_org UUID := current_setting('test.lm.org_id')::uuid;
  v_branch UUID := current_setting('test.lm.branch_id')::uuid;
  v_client UUID := current_setting('test.lm.client_id')::uuid;
  v_sender UUID := current_setting('test.lm.sender_id')::uuid;
  v_recipient UUID := current_setting('test.lm.recipient_id')::uuid;
  v_shipment UUID := current_setting('test.lm.shipment_id')::uuid;
  v_tenant_user UUID := current_setting('test.lm.tenant_user_id')::uuid;
  v_client_user UUID := current_setting('test.lm.client_user_id')::uuid;
  v_sender_user UUID := current_setting('test.lm.sender_user_id')::uuid;
  v_tracking UUID := current_setting('test.lm.tracking_session_id')::uuid;
  v_return UUID := current_setting('test.lm.return_id')::uuid;
  v_case UUID := current_setting('test.lm.support_case_id')::uuid;
  v_plan UUID := current_setting('test.lm.route_plan_id')::uuid;
  v_invoice UUID := current_setting('test.lm.invoice_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'LM CX Org', 'lm-cx-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.branches (id, organization_id, code, name, is_active)
  VALUES (v_branch, v_org, 'b1', 'Branch 1', TRUE)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Client 1', 'client-1', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'Sender 1', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, access_scope_type, access_scope_id)
  VALUES
    (v_tenant_user, v_org, 'tenant-' || left(v_tenant_user::text, 8) || '@example.com', 'Tenant User', 'tenant', NULL),
    (v_client_user, v_org, 'client-' || left(v_client_user::text, 8) || '@example.com', 'Client User', 'client', v_client),
    (v_sender_user, v_org, 'sender-' || left(v_sender_user::text, 8) || '@example.com', 'Sender User', 'sender', v_sender)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (id, organization_id, client_id, name, phone_number)
  VALUES (v_recipient, v_org, v_client, 'Recipient 1', '+15555550101')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.shipments (id, organization_id, client_id, sender_id, service_type, tracking_number, box_count, status, recipient_id)
  VALUES (v_shipment, v_org, v_client, v_sender, 'delivery', 'LMTEST' || left(v_shipment::text, 6), 1, 'pending', v_recipient)
  ON CONFLICT DO NOTHING;

  INSERT INTO public.tracking_sessions (id, organization_id, client_id, sender_id, shipment_id, recipient_id, token)
  VALUES (v_tracking, v_org, v_client, v_sender, v_shipment, v_recipient, 'secret-token-123')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.returns (id, organization_id, client_id, sender_id, shipment_id, return_type, status, branch_id, created_by_user_id)
  VALUES (v_return, v_org, v_client, v_sender, v_shipment, 'rto', 'requested', v_branch, v_tenant_user)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_cases (id, organization_id, client_id, sender_id, resource_type, resource_id, status, priority, assigned_to)
  VALUES (v_case, v_org, v_client, v_sender, 'shipment', v_shipment, 'open', 'medium', v_tenant_user)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.support_messages (support_case_id, organization_id, direction, channel, actor_user_id, body)
  VALUES (v_case, v_org, 'inbound', 'in_app', v_client_user, 'Where is my order?');

  INSERT INTO public.feedback_events (organization_id, client_id, sender_id, recipient_id, shipment_id, channel, rating, nps_score, comment)
  VALUES (v_org, v_client, v_sender, v_recipient, v_shipment, 'in_app', 5, 10, 'Great');

  INSERT INTO public.route_plans (id, organization_id, branch_id, planned_date, status, requested_by_user_id, requested_at)
  VALUES (v_plan, v_org, v_branch, now()::date, 'created', v_tenant_user, now())
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.route_plan_events (route_plan_id, organization_id, event_type, from_status, to_status, actor_user_id, payload, plan_version)
  VALUES (v_plan, v_org, 'created', NULL, 'created', v_tenant_user, '{}'::jsonb, 1);

  INSERT INTO public.billing_invoices (id, organization_id, client_id, sender_id, status, currency, total, amount_due, created_by_user_id)
  VALUES (v_invoice, v_org, v_client, v_sender, 'issued', 'USD', 10, 10, v_tenant_user)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.billing_invoice_lines (invoice_id, organization_id, line_type, description, quantity, unit_price, amount, currency)
  VALUES (v_invoice, v_org, 'shipment_charge', 'Delivery charge', 1, 10, 10, 'USD');

  INSERT INTO public.billing_invoice_events (invoice_id, organization_id, event_type, from_status, to_status, actor_user_id, payload, invoice_version)
  VALUES (v_invoice, v_org, 'issued', 'draft', 'issued', v_tenant_user, '{}'::jsonb, 1);
END $$;

-- Tracking token redaction works (token cleared, token_hash set).
DO $$
DECLARE
  v_tracking UUID := current_setting('test.lm.tracking_session_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM ok((SELECT token IS NULL FROM public.tracking_sessions WHERE id = v_tracking), 'tracking_sessions token is redacted');
  PERFORM ok((SELECT token_hash IS NOT NULL FROM public.tracking_sessions WHERE id = v_tracking), 'tracking_sessions token_hash is set');
END $$;

-- Lookup enforcement: invalid return status is rejected.
DO $$
DECLARE
  v_org UUID := current_setting('test.lm.org_id')::uuid;
  v_client UUID := current_setting('test.lm.client_id')::uuid;
  v_sender UUID := current_setting('test.lm.sender_id')::uuid;
  v_shipment UUID := current_setting('test.lm.shipment_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM throws_ok(
    format($sql$
      INSERT INTO public.returns (organization_id, client_id, sender_id, shipment_id, return_type, status)
      VALUES (%L::uuid, %L::uuid, %L::uuid, %L::uuid, 'rto', 'not_a_real_status')
    $sql$, v_org::text, v_client::text, v_sender::text, v_shipment::text),
    '23514',
    'Invalid lookup value for public.returns.status: "not_a_real_status" is not an allowed value for category "return_status"'
  );
END $$;

-- Client user can see client-scoped objects but cannot see route_plans.
DO $$
DECLARE
  v_client_user UUID := current_setting('test.lm.client_user_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_client_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM is((SELECT COUNT(*)::INT FROM public.returns), 1, 'client user can read returns');
  PERFORM is((SELECT COUNT(*)::INT FROM public.tracking_sessions), 1, 'client user can read tracking_sessions');
  PERFORM is((SELECT COUNT(*)::INT FROM public.support_cases), 1, 'client user can read support_cases');
  PERFORM is((SELECT COUNT(*)::INT FROM public.support_messages), 1, 'client user can read support_messages');
  PERFORM is((SELECT COUNT(*)::INT FROM public.feedback_events), 1, 'client user can read feedback_events');
  PERFORM is((SELECT COUNT(*)::INT FROM public.billing_invoices), 1, 'client user can read billing_invoices');
  PERFORM is((SELECT COUNT(*)::INT FROM public.route_plans), 0, 'client user cannot read route_plans');
END $$;

-- Sender user can see sender-scoped objects but cannot see route_plans.
DO $$
DECLARE
  v_sender_user UUID := current_setting('test.lm.sender_user_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_sender_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM is((SELECT COUNT(*)::INT FROM public.returns), 1, 'sender user can read returns');
  PERFORM is((SELECT COUNT(*)::INT FROM public.tracking_sessions), 1, 'sender user can read tracking_sessions');
  PERFORM is((SELECT COUNT(*)::INT FROM public.support_cases), 1, 'sender user can read support_cases');
  PERFORM is((SELECT COUNT(*)::INT FROM public.support_messages), 1, 'sender user can read support_messages');
  PERFORM is((SELECT COUNT(*)::INT FROM public.billing_invoices), 1, 'sender user can read billing_invoices');
  PERFORM is((SELECT COUNT(*)::INT FROM public.route_plans), 0, 'sender user cannot read route_plans');
END $$;

-- Tenant user can read route_plans and other org-scoped objects.
DO $$
DECLARE
  v_tenant_user UUID := current_setting('test.lm.tenant_user_id')::uuid;
BEGIN
  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_tenant_user::text, TRUE);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, TRUE);

  PERFORM is((SELECT COUNT(*)::INT FROM public.route_plans), 1, 'tenant user can read route_plans');
  PERFORM is((SELECT COUNT(*)::INT FROM public.route_plan_events), 1, 'tenant user can read route_plan_events');
END $$;

SELECT finish();
ROLLBACK;
