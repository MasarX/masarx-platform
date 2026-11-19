-- pgTAP: public.v_recipient_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W21 (paired projection views — CUSTOMERS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_recipient_directory',
  'public.v_recipient_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_recipient_directory',
  ARRAY[
    'recipient_id', 'id', 'organization_id', 'client_id', 'external_id',
    'name', 'phone_number', 'phone_validation_status', 'email',
    'preferred_language', 'preferred_comm_channel',
    'quiet_hours_start', 'quiet_hours_end', 'communication_preferences',
    'updated_at',
    'client_label', 'client_slug',
    'total_shipments', 'last_shipment_at', 'last_shipment_status',
    'phone_validated', 'has_quiet_hours'
  ],
  'v_recipient_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_recipient_directory', 'SELECT'),
  'service_role has SELECT on v_recipient_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_recipient_directory', 'SELECT'),
  'anon has no SELECT on v_recipient_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_recipient_directory', 'SELECT'),
  'authenticated has SELECT on v_recipient_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'recipients'
       AND c.relkind = 'r'
  ),
  'public.recipients remains a base table (SSOT preserved)'
);

-- 7) Projection: client join + derived booleans resolve.
DO $$
DECLARE
  v_org    UUID := '00000000-0000-0000-0000-00000021e001';
  v_client UUID := '00000000-0000-0000-0000-00000021e002';
  v_rcp    UUID := '00000000-0000-0000-0000-00000021e003';
  v_label  TEXT;
  v_validated BOOLEAN;
  v_quiet  BOOLEAN;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W21 Recipient Directory Org', 'w21-rd-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (
    id, organization_id, name, slug, sla_tier, status
  )
  VALUES (
    v_client, v_org, 'W21 Recipient Client',
    'w21-rcl-' || left(v_client::text, 8),
    'standard', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.recipients (
    id, organization_id, client_id, name, phone_number,
    phone_validation_status, quiet_hours_start, quiet_hours_end
  )
  VALUES (
    v_rcp, v_org, v_client, 'W21 Test Recipient',
    '+966500000022', 'valid', '22:00'::TIME, '08:00'::TIME
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT client_label, phone_validated, has_quiet_hours
    INTO v_label, v_validated, v_quiet
    FROM public.v_recipient_directory
   WHERE recipient_id = v_rcp;

  PERFORM ok(
    v_label = 'W21 Recipient Client'
      AND v_validated = TRUE
      AND v_quiet = TRUE,
    'v_recipient_directory derives client_label + phone_validated + has_quiet_hours'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
