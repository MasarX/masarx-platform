BEGIN;

SELECT plan(6);

DO $$
DECLARE
  v_org uuid := '00000000-0000-0000-0000-00000000c510';
  v_client uuid := '00000000-0000-0000-0000-00000000c511';
  v_ops uuid := '00000000-0000-0000-0000-00000000c512';
  v_res jsonb;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console Billing Number Org', 'console-billing-number-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client, v_org, 'Console Billing Number Client', 'console-billing-number-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (v_ops, v_org, 'console-billing-number@example.com', 'Console Billing Number Ops', 'ops_admin', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.billing_number_org', v_org::text, true);
  PERFORM set_config('test.billing_number_client', v_client::text, true);
  PERFORM set_config('test.billing_number_ops', v_ops::text, true);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  COALESCE(public.resolve_settings_merged('billing_policy', 'tenant', current_setting('test.billing_number_org')::uuid), '{}'::jsonb)
    ? 'invoice_numbering',
  'billing_policy resolves invoice_numbering metadata'
);

SELECT ok(
  (public.next_billing_invoice_number_v1(current_setting('test.billing_number_org')::uuid) ~ '^INV-[0-9]{8}-[0-9]{6,}$'),
  'next_billing_invoice_number_v1 returns configured operator identifier'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.billing_number_ops'), true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  v_res jsonb;
BEGIN
  v_res := public.create_billing_invoice_v1(jsonb_build_object(
    'client_id', current_setting('test.billing_number_client'),
    'currency', 'sar',
    'subtotal', 0,
    'tax_total', 0,
    'idempotency_key', 'console-billing-create-numbering'
  ));
  PERFORM set_config('test.billing_number_invoice_id', v_res->>'billing_invoice_id', true);
  PERFORM set_config('test.billing_number_invoice_number', v_res->>'invoice_number', true);
END $$;
RESET ROLE;

SELECT ok(
  current_setting('test.billing_number_invoice_number') ~ '^INV-[0-9]{8}-[0-9]{6,}$',
  'create_billing_invoice_v1 returns generated invoice_number'
);

SELECT is(
  (
    SELECT invoice_number
    FROM public.billing_invoices
    WHERE id = current_setting('test.billing_number_invoice_id')::uuid
  ),
  current_setting('test.billing_number_invoice_number'),
  'created billing_invoices row stores generated invoice_number'
);

SELECT is(
  (
    SELECT payload->>'invoice_number'
    FROM public.billing_invoice_events
    WHERE invoice_id = current_setting('test.billing_number_invoice_id')::uuid
      AND event_type = 'billing_invoice.created'
    ORDER BY created_at DESC
    LIMIT 1
  ),
  current_setting('test.billing_number_invoice_number'),
  'billing_invoice.created event stores generated invoice_number'
);

SELECT is(
  (
    SELECT invoice_number
    FROM public.v_billing_invoice_directory
    WHERE invoice_id = current_setting('test.billing_number_invoice_id')::uuid
  ),
  current_setting('test.billing_number_invoice_number'),
  'billing invoice directory projects generated invoice_number'
);

SELECT * FROM finish();

ROLLBACK;
