-- Spec-Issue: W41 closure of W40 local-Supabase E2E findings (F4)
-- Step: W41-F4
-- Migration: View rewrite fixup for 202604301430_driver_profile_summary_v1
--
-- W40 finding (P1):
--   docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log
--     HARD-FAIL 202604301430_driver_profile_summary_v1.sql:
--       column u.phone does not exist
--
-- Root cause:
--   The view definition references `u.phone` from public.users (alias `u`),
--   but the canonical users table (declared in
--   202510110002_configuration_core.sql) only has columns:
--     id, organization_id, email, full_name, user_type, status,
--     created_at, last_login_at
--   No `phone` column ever existed on public.users. Repository-wide grep
--   confirms `u.phone` / `users.phone` is referenced ONLY in this view; no
--   other migration ADDs the column. The W40 verification confirms the
--   migration is fictional w.r.t. the canonical schema.
--
-- Closure decision (path b in the W41 brief):
--   Rewrite public.driver_profile_summary_v1 to source `phone` from
--   driver_profiles.metadata->>'phone' only. This is consistent with how
--   other metadata fallbacks (compliance_score, license_class, etc.) are
--   already projected in this view, and aligns with the canonical SSOT
--   (driver_profiles for driver-scoped profile fields).
--
--   Future canonical source for users.phone (e.g. via a new ALTER TABLE
--   migration adding the column with appropriate RLS) can extend this view
--   in another additive migration without breaking the FE swap-seam.
--
-- Append-only: this migration creates new objects only (CREATE OR REPLACE
-- VIEW). It does NOT edit any historical migration file.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605010004_w41_driver_profile_summary_phone_fixup'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.driver_profile_summary_v1 CASCADE;

CREATE VIEW public.driver_profile_summary_v1 WITH (security_invoker = true) AS
WITH active_assignment AS (
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
  -- W41 F4: phone now sourced from driver_profiles.metadata only.
  -- public.users does not have a `phone` column; sourcing through
  -- profile metadata keeps the view canonical and FE-stable.
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

  -- Active assignment projections
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
  -- resolver).
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
  'FE-friendly denormalized projection of driver_profiles. Read-only; SSOT remains driver_profiles. (W41 F4: phone sourced from dp.metadata->>''phone'' since users.phone does not exist on the canonical schema.)';

REVOKE ALL ON public.driver_profile_summary_v1 FROM PUBLIC;
REVOKE ALL ON public.driver_profile_summary_v1 FROM anon;
REVOKE ALL ON public.driver_profile_summary_v1 FROM authenticated;
GRANT SELECT ON public.driver_profile_summary_v1 TO authenticated;
GRANT SELECT ON public.driver_profile_summary_v1 TO service_role;

SELECT pg_advisory_unlock(hashtext('202605010004_w41_driver_profile_summary_phone_fixup'));

COMMIT;
