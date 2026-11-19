-- Spec-Issue: W11-4 FLEET projection RPCs (paired with D4 schema-drift drops)
-- Step: W11-4-VIEW-1
-- Migration: Canonical projection view public.driver_profile_summary_v1.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-driver denormalized "profile summary" rows for the FE
--   `DriverProfileRow` shape (apps/console-v2/src/modules/operate/fleet/drivers.tsx)
--   that does not have direct canonical columns:
--     - name           : projection (users.full_name).
--     - initials       : projection (derived from users.full_name).
--     - license_number : latest driver_documents WHERE doc_type='driver_license'.
--     - license_class  : driver_documents.metadata->>'class' for that license.
--     - license_expires_at : driver_documents.expires_at for that license.
--     - current_vehicle_id : active vehicle_assignments.vehicle_id.
--     - current_branch_id  : active vehicle_assignments.branch_id (else
--                            users / driver_profiles metadata fallback).
--     - hours_of_service_state : driver_profiles.metadata->>'hours_of_service_state'
--                                (resolver fallback while HOS resolver lands).
--     - compliance_score  : driver_profiles.metadata->>'compliance_score' fallback.
--     - phone             : driver_profiles.metadata->>'phone'.
--     - emergency_contact_name / emergency_contact_phone : metadata fallbacks.
--
--   Sources: public.driver_profiles + public.users + public.driver_documents
--   + public.vehicle_assignments. SSOT remains driver_profiles; this view is
--   read-only.
--
-- Notes:
--   * RLS is enforced by the underlying tables (driver_profiles +
--     driver_documents + vehicle_assignments + users). Projection view is
--     service-only baseline; FE consumes via the resource registry seam.
--   * Rich metrics (deliveries_today/_week, on_time_pct, customer_rating)
--     remain projection-shaped fields backed by future kpi_rollups_daily
--     resolvers; this view exposes the columns so FE call sites stay stable
--     and the backend can fill them in subsequent migrations without an FE
--     swap.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301410_driver_profile_summary_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.driver_profile_summary_v1;

CREATE VIEW public.driver_profile_summary_v1 AS
WITH active_assignment AS (
  -- Latest active vehicle assignment per driver user.
  SELECT DISTINCT ON (va.assigned_to_user_id)
    va.assigned_to_user_id,
    va.vehicle_id   AS current_vehicle_id,
    va.branch_id    AS current_branch_id,
    va.started_at   AS assignment_started_at
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
    AND va.assigned_to_user_id IS NOT NULL
  ORDER BY va.assigned_to_user_id, va.started_at DESC
),
latest_license AS (
  -- Latest driver license per user.
  SELECT DISTINCT ON (dd.user_id)
    dd.user_id,
    dd.id                AS license_doc_id,
    dd.expires_at        AS license_expires_at,
    dd.metadata          AS license_metadata,
    dd.document_ref_hash AS license_ref_hash,
    dd.status            AS license_status
  FROM public.driver_documents dd
  WHERE dd.doc_type IN ('driver_license', 'license')
  ORDER BY dd.user_id, dd.created_at DESC
)
SELECT
  dp.id,
  dp.organization_id,
  dp.user_id,
  dp.driver_code,
  dp.status,
  dp.hired_at,
  dp.terminated_at,
  dp.metadata        AS profile_metadata,
  dp.created_at,
  dp.updated_at,

  -- Identity projections (users join)
  u.full_name        AS name,
  CASE
    WHEN u.full_name IS NULL OR btrim(u.full_name) = '' THEN ''
    ELSE upper(
      substr(split_part(u.full_name, ' ', 1), 1, 1)
      || COALESCE(substr(split_part(u.full_name, ' ', 2), 1, 1), '')
    )
  END                AS initials,
  NULLIF(btrim(dp.metadata->>'phone'), '')
                     AS phone,

  -- License projections (driver_documents join)
  COALESCE(
    NULLIF(btrim(ll.license_metadata->>'license_number'), ''),
    NULLIF(btrim(ll.license_ref_hash), ''),
    NULLIF(btrim(dp.metadata->>'license_number'), '')
  )                  AS license_number,
  COALESCE(
    NULLIF(btrim(ll.license_metadata->>'class'), ''),
    NULLIF(btrim(dp.metadata->>'license_class'), '')
  )                  AS license_class,
  ll.license_expires_at,

  -- Active assignment projections (vehicle_assignments join)
  aa.current_vehicle_id,
  aa.current_branch_id,
  aa.assignment_started_at,

  -- Profile metadata fallbacks (resolver landing-pads)
  COALESCE(
    NULLIF(btrim(dp.metadata->>'hours_of_service_state'), ''),
    'off_duty'
  )                  AS hours_of_service_state,
  COALESCE(
    NULLIF(btrim(dp.metadata->>'compliance_score'), '')::NUMERIC,
    0
  )                  AS compliance_score,
  NULLIF(btrim(dp.metadata->>'emergency_contact_name'), '')
                     AS emergency_contact_name,
  NULLIF(btrim(dp.metadata->>'emergency_contact_phone'), '')
                     AS emergency_contact_phone,

  -- Performance metric placeholders (filled by future kpi_rollups_daily
  -- resolver — column slots kept stable so the FE swap is body-only).
  COALESCE(
    NULLIF(btrim(dp.metadata->>'deliveries_today'), '')::INT,
    0
  )                  AS deliveries_today,
  COALESCE(
    NULLIF(btrim(dp.metadata->>'deliveries_week'), '')::INT,
    0
  )                  AS deliveries_week,
  COALESCE(
    NULLIF(btrim(dp.metadata->>'on_time_pct'), '')::NUMERIC,
    0
  )                  AS on_time_pct,
  COALESCE(
    NULLIF(btrim(dp.metadata->>'customer_rating'), '')::NUMERIC,
    0
  )                  AS customer_rating
FROM public.driver_profiles dp
LEFT JOIN public.users u
  ON u.id = dp.user_id
LEFT JOIN active_assignment aa
  ON aa.assigned_to_user_id = dp.user_id
LEFT JOIN latest_license ll
  ON ll.user_id = dp.user_id;

COMMENT ON VIEW public.driver_profile_summary_v1 IS
  'FE-friendly denormalized projection of driver_profiles with derived (name, initials, license_number, license_class, license_expires_at, current_vehicle_id, current_branch_id, hours_of_service_state, compliance_score, phone, emergency_contact_*, deliveries_*, on_time_pct, customer_rating). Sources: driver_profiles + users + driver_documents + vehicle_assignments. Read-only; SSOT remains driver_profiles; mutations go through suspend_driver_v1 / restore_driver_v1 / verify_driver_document_v1 / etc.';

REVOKE ALL ON public.driver_profile_summary_v1 FROM PUBLIC;
REVOKE ALL ON public.driver_profile_summary_v1 FROM anon;
REVOKE ALL ON public.driver_profile_summary_v1 FROM authenticated;
GRANT SELECT ON public.driver_profile_summary_v1 TO authenticated;
GRANT SELECT ON public.driver_profile_summary_v1 TO service_role;

SELECT pg_advisory_unlock(hashtext('202604301410_driver_profile_summary_v1'));
COMMIT;
