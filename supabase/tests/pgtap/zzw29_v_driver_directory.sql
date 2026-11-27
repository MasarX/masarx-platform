-- pgTAP: public.v_driver_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W29 (paired projection views — FLEET)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(7);

-- 1) View exists
SELECT has_view(
  'public', 'v_driver_directory',
  'public.v_driver_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_driver_directory',
  ARRAY[
    'id', 'organization_id', 'user_id', 'driver_code', 'status',
    'hired_at', 'terminated_at', 'phone', 'emergency_contact_name', 'emergency_contact_phone',
    'license_number', 'license_class', 'license_expires_at',
    'created_at', 'updated_at',
    'user_full_name', 'user_email',
    'current_vehicle_id', 'current_branch_id',
    'active_assignment_started_at',
    'vehicle_plate', 'vehicle_label', 'branch_label',
    'document_count', 'expired_document_count',
    'expiring_document_count', 'earliest_document_expiry',
    'compliance_event_count', 'compliance_event_count_24h',
    'critical_compliance_count', 'last_compliance_event_at',
    'hos_segment_count', 'hos_segment_count_24h', 'last_active_at',
    'hos_active_segment_id', 'hos_active_duty_status',
    'hos_active_segment_started_at',
    'is_active', 'is_suspended', 'is_inactive',
    'has_expired_documents', 'has_expiring_documents', 'tenure_seconds',
    'deliveries_today', 'deliveries_week', 'on_time_pct', 'customer_rating'
  ],
  'v_driver_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_driver_directory', 'SELECT'),
  'service_role has SELECT on v_driver_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_driver_directory', 'SELECT'),
  'anon has no SELECT on v_driver_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_driver_directory', 'SELECT'),
  'authenticated has SELECT on v_driver_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'driver_profiles'
       AND c.relkind = 'r'
  ),
  'public.driver_profiles remains a base table (SSOT preserved)'
);

-- 7) Projection: insert driver_profile + user + 1 expired doc + 1 expiring doc
--    + 1 fresh compliance event + 1 open HOS segment, then verify all derived
--    counters and labels.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000029b001';
  v_user      UUID := '00000000-0000-0000-0000-00000029b002';
  v_dp        UUID := '00000000-0000-0000-0000-00000029b003';
  v_doc_a     UUID := '00000000-0000-0000-0000-00000029b004';
  v_doc_b     UUID := '00000000-0000-0000-0000-00000029b005';
  v_event     UUID := '00000000-0000-0000-0000-00000029b006';
  v_hos       UUID := '00000000-0000-0000-0000-00000029b007';
  v_full      TEXT;
  v_doc_count INT;
  v_doc_exp   INT;
  v_doc_expg  INT;
  v_event_24h INT;
  v_critical  INT;
  v_hos_count INT;
  v_hos_24h   INT;
  v_open_id   UUID;
  v_open_st   TEXT;
  v_active    BOOLEAN;
  v_susp      BOOLEAN;
  v_has_exp   BOOLEAN;
  v_tenure    BIGINT;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W29 Driver Org', 'w29-drv-' || left(v_org::text, 8))
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org, 'w29-drv-u-' || left(v_user::text, 8) || '@example.com',
    'W29 Driver Khalid', 'driver', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.driver_profiles (
    id, organization_id, user_id, driver_code, status, hired_at
  )
  VALUES (
    v_dp, v_org, v_user, 'W29-DRV-001', 'active',
    now() - INTERVAL '90 days'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Document A: expired 5 days ago.
  INSERT INTO public.driver_documents (
    id, organization_id, user_id, doc_type, status, issuer,
    issued_at, expires_at
  )
  VALUES (
    v_doc_a, v_org, v_user, 'driver_license', 'verified',
    'MOT', (CURRENT_DATE - INTERVAL '365 days')::DATE,
    (CURRENT_DATE - INTERVAL '5 days')::DATE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Document B: expiring in 10 days.
  INSERT INTO public.driver_documents (
    id, organization_id, user_id, doc_type, status, issuer,
    issued_at, expires_at
  )
  VALUES (
    v_doc_b, v_org, v_user, 'national_id', 'verified',
    'MOI', (CURRENT_DATE - INTERVAL '180 days')::DATE,
    (CURRENT_DATE + INTERVAL '10 days')::DATE
  )
  ON CONFLICT (id) DO NOTHING;

  -- Compliance event 6 hours ago, severity=critical.
  INSERT INTO public.driver_compliance_events (
    id, organization_id, user_id, event_type, payload, created_at
  )
  VALUES (
    v_event, v_org, v_user, 'incident.major',
    jsonb_build_object('severity', 'critical', 'impact', 'minor_injury'),
    now() - INTERVAL '6 hours'
  )
  ON CONFLICT (id) DO NOTHING;

  -- Open HOS segment (started 3 hours ago, segment_end NULL).
  INSERT INTO public.driver_hours_of_service (
    id, organization_id, driver_id, segment_start, duty_status
  )
  VALUES (
    v_hos, v_org, v_dp, now() - INTERVAL '3 hours', 'driving'
  )
  ON CONFLICT (id) DO NOTHING;

  SELECT
    user_full_name, document_count, expired_document_count,
    expiring_document_count, compliance_event_count_24h, critical_compliance_count,
    hos_segment_count, hos_segment_count_24h,
    hos_active_segment_id, hos_active_duty_status,
    is_active, is_suspended, has_expired_documents, tenure_seconds
    INTO
    v_full, v_doc_count, v_doc_exp,
    v_doc_expg, v_event_24h, v_critical,
    v_hos_count, v_hos_24h,
    v_open_id, v_open_st,
    v_active, v_susp, v_has_exp, v_tenure
    FROM public.v_driver_directory
   WHERE id = v_dp;

  PERFORM ok(
    v_full = 'W29 Driver Khalid'
      AND v_doc_count = 2
      AND v_doc_exp = 1
      AND v_doc_expg = 1
      AND v_event_24h = 1
      AND v_critical = 1
      AND v_hos_count = 1
      AND v_hos_24h = 1
      AND v_open_id = v_hos
      AND v_open_st = 'driving'
      AND v_active = TRUE
      AND v_susp = FALSE
      AND v_has_exp = TRUE
      AND v_tenure IS NOT NULL
      AND v_tenure > 60 * 60 * 24 * 80,  -- > 80 days tenure
    'v_driver_directory derives user_full_name + document_count + expired_document_count + expiring_document_count + compliance_event_count_24h + critical_compliance_count + hos_segment_count_24h + hos_active_segment_id + status booleans + tenure_seconds'
  );
END;
$$;

SELECT * FROM finish();
ROLLBACK;
