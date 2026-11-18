-- pgTAP: public.v_client_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W21 (paired projection views — CUSTOMERS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_client_summary',
  'public.v_client_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_client_summary',
  ARRAY[
    'client_id', 'id', 'organization_id', 'name', 'slug', 'sla_tier', 'status',
    'account_manager_id', 'contract_start_date', 'contract_end_date',
    'suspension_reason', 'warehouse_address_id', 'billing_settings',
    'settings_override', 'updated_at',
    'sender_count', 'recipient_count', 'active_shipments', 'total_shipments',
    'last_shipment_at', 'contract_active', 'has_warehouse'
  ],
  'v_client_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_client_summary', 'SELECT'),
  'service_role has SELECT on v_client_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_client_summary', 'SELECT'),
  'anon has no SELECT on v_client_summary'
);

-- 5) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_client_summary', 'SELECT'),
  'authenticated has SELECT on v_client_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'clients'
       AND c.relkind = 'r'  -- still a regular table
  ),
  'public.clients remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a client, verify counters resolve through the view.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000021c001';
  v_client UUID := '00000000-0000-0000-0000-00000021c002';
  v_sender UUID := '00000000-0000-0000-0000-00000021c003';
  v_rcp    UUID := '00000000-0000-0000-0000-00000021c004';
  v_sender_count INT;
  v_expected_sender_count INT;
  v_recipient_count INT;
  v_contract_active BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W21 Client Summary Org', 'w21-cs-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status,
    contract_start_date, contract_end_date
  )
  VALUES (
    v_client, v_org, 'W21 Test Client', 'w21-test-' || left(v_client::text, 8),
    'standard', 'active', '2025-01-01', '2030-12-31'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'W21 Test Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (
    id, organization_id, client_id, name, phone_number
  )
  VALUES (v_rcp, v_org, v_client, 'W21 Test Recipient', '+966500000021')
  ON CONFLICT (id) DO NOTHING;

  SELECT sender_count, recipient_count, contract_active
    INTO v_sender_count, v_recipient_count, v_contract_active
    FROM public.v_client_summary
   WHERE client_id = v_client;

  SELECT COUNT(*)::INT
    INTO v_expected_sender_count
    FROM public.senders
   WHERE client_id = v_client
     AND status = 'active';

  PERFORM set_config(
    'test.w21_client_summary_projection_ok',
    (v_sender_count = v_expected_sender_count AND v_recipient_count = 1 AND v_contract_active = TRUE)::text,
    true
  );
  EXECUTE 'RESET ROLE';
END;
$$;

SELECT ok(
  current_setting('test.w21_client_summary_projection_ok')::boolean,
  'v_client_summary derives sender_count + recipient_count + contract_active'
);

-- 8) Contract_active is FALSE for terminated client.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000021c011';
  v_client_t UUID := '00000000-0000-0000-0000-00000021c012';
  v_active   BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W21 Terminated Org', 'w21-cs-t-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status, suspension_reason
  )
  VALUES (
    v_client_t, v_org, 'W21 Terminated Client',
    'w21-term-' || left(v_client_t::text, 8),
    'standard', 'terminated', 'contract-ended'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT contract_active
    INTO v_active
    FROM public.v_client_summary
   WHERE client_id = v_client_t;

  PERFORM set_config(
    'test.w21_client_summary_terminated_ok',
    (v_active = FALSE)::text,
    true
  );
  EXECUTE 'RESET ROLE';
END;
$$;

SELECT ok(
  current_setting('test.w21_client_summary_terminated_ok')::boolean,
  'v_client_summary.contract_active = FALSE for terminated client'
);

SELECT * FROM finish();
ROLLBACK;
