-- pgTAP: public.v_sender_summary projection contract (shape/RLS/projection)
-- Spec-Issue: W21 (paired projection views — CUSTOMERS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_sender_summary',
  'public.v_sender_summary view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_sender_summary',
  ARRAY[
    'sender_id', 'id', 'client_id', 'name', 'brand_name',
    'auto_provisioned', 'auto_recreate', 'warehouse_address_id',
    'settings_override', 'status', 'updated_at',
    'client_label', 'client_slug', 'sla_tier_inherited',
    'organization_id_resolved', 'effective_warehouse_id', 'has_warehouse',
    'active_shipments', 'total_shipments', 'last_shipment_at'
  ],
  'v_sender_summary exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_sender_summary', 'SELECT'),
  'service_role has SELECT on v_sender_summary'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_sender_summary', 'SELECT'),
  'anon has no SELECT on v_sender_summary'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_sender_summary', 'SELECT'),
  'authenticated has SELECT on v_sender_summary'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'senders'
       AND c.relkind = 'r'
  ),
  'public.senders remains a base table (SSOT preserved)'
);

-- 7) Projection: client join surfaces label + organization_id_resolved + sla_tier_inherited.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000021d001';
  v_client UUID := '00000000-0000-0000-0000-00000021d002';
  v_sender UUID := '00000000-0000-0000-0000-00000021d003';
  v_label  TEXT;
  v_sla    TEXT;
  v_resolved_org UUID;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W21 Sender Summary Org', 'w21-ss-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W21 Sender Client', 'w21-sc-' || left(v_client::text, 8),
    'premium', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.senders (id, client_id, name, status)
  VALUES (v_sender, v_client, 'W21 Test Sender', 'active')
  ON CONFLICT (id) DO NOTHING;

  SELECT client_label, sla_tier_inherited, organization_id_resolved
    INTO v_label, v_sla, v_resolved_org
    FROM public.v_sender_summary
   WHERE sender_id = v_sender;

  PERFORM ok(
    v_label = 'W21 Sender Client'
      AND v_sla = 'premium'
      AND v_resolved_org = v_org,
    'v_sender_summary derives client_label + sla_tier_inherited + organization_id_resolved'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
