-- Spec-Issue: W29 FLEET gap closure (paired projection views)
-- Step: W29-VIEW-2
-- Migration: Canonical projection view public.v_driver_directory.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-driver derived counters + label rollups used by
--   `apps/console-v2/src/modules/operate/fleet/drivers.tsx` (DriverProfileRow):
--     - branch_label              : derived projection from active
--                                     vehicle_assignments.branch_id JOIN
--                                     branches.code + name (NULL when
--                                     unassigned).
--     - vehicle_label             : derived from vehicles.plate_number JOIN
--                                     on the active assignment vehicle_id
--                                     (NULL when unassigned).
--     - document_count            : derived COUNT(driver_documents) per
--                                     user_id.
--     - expired_document_count    : derived COUNT(driver_documents WHERE
--                                     expires_at IS NOT NULL AND
--                                     expires_at <= CURRENT_DATE).
--     - expiring_document_count   : derived COUNT(driver_documents WHERE
--                                     expires_at IS NOT NULL AND
--                                     expires_at > CURRENT_DATE AND
--                                     expires_at <= CURRENT_DATE +
--                                     INTERVAL '30 days') (FE renders the
--                                     "Docs expiring < 30 days" KPI tile).
--     - earliest_document_expiry  : derived MIN(driver_documents.expires_at)
--                                     per user_id (FE worst-of expiry chip).
--     - compliance_event_count    : derived COUNT(driver_compliance_events)
--                                     per user_id.
--     - compliance_event_count_24h: derived COUNT(driver_compliance_events
--                                     WHERE created_at >= now() -
--                                     INTERVAL '24 hours').
--     - critical_compliance_count : derived COUNT(driver_compliance_events
--                                     WHERE payload->>'severity' = 'critical').
--     - hos_segment_count         : derived COUNT(driver_hours_of_service)
--                                     per driver_id (driver_profiles.id).
--     - hos_segment_count_24h     : derived COUNT(driver_hours_of_service
--                                     WHERE segment_start >= now() -
--                                     INTERVAL '24 hours').
--     - hos_active_segment_id     : derived id of the currently open
--                                     duty segment (segment_end IS NULL).
--     - hos_active_duty_status    : derived duty_status of the currently open
--                                     duty segment.
--     - last_active_at            : derived MAX(driver_hours_of_service.
--                                     segment_start) per driver_id.
--     - is_active                 : derived alias for status = 'active'.
--     - is_suspended              : derived alias for status = 'suspended'.
--     - has_expired_documents     : derived BOOLEAN — TRUE when
--                                     expired_document_count > 0.
--     - tenure_seconds            : derived seconds since hired_at (NULL
--                                     when hired_at NULL).
--
--   The FE `DriverProfileRow` interface at apps/console-v2/src/modules/
--   operate/fleet/drivers.tsx currently consumes the projection-shaped
--   fields via `_projectDriverProfileSummary` (W11-4 view
--   driver_profile_summary_v1). v_driver_directory unifies the existing
--   W11-4 projection with the additional counters + status booleans so the
--   FE KPI strip (Active/Inactive/Suspended/Docs expiring/Out of service)
--   and per-row chip rendering can move onto canonical SSOT instead of
--   synthesizing client-side.
--
-- Notes:
--   * SSOT remains public.driver_profiles; this view is read-only.
--   * RLS is enforced by the underlying tables (driver_profiles,
--     driver_documents, driver_compliance_events, driver_hours_of_service,
--     vehicle_assignments, vehicles, branches, users) via
--     security_invoker = true.
--   * Service-role + authenticated SELECT (mirrors W22-W28 paired projection
--     grants).
--   * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/FLEET.md §1-§3
--   - FE shape: apps/console-v2/src/modules/operate/fleet/drivers.tsx:105
--   - Canonical table: 202601311230_enterprise_ops_v1.sql:333 (driver_profiles)
--   - Sibling view: 202604301430_driver_profile_summary_v1.sql (paired by
--     enriched profile fields; this view extends with lifecycle + counter
--     aggregates).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302710_v_driver_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_driver_directory;

CREATE VIEW public.v_driver_directory
  WITH (security_invoker = true)
  AS
WITH active_assignment AS (
  SELECT DISTINCT ON (va.assigned_to_user_id)
    va.assigned_to_user_id,
    va.vehicle_id,
    va.branch_id,
    va.started_at
  FROM public.vehicle_assignments va
  WHERE va.status = 'active'
    AND va.ended_at IS NULL
    AND va.assigned_to_user_id IS NOT NULL
  ORDER BY va.assigned_to_user_id, va.started_at DESC
),
document_agg AS (
  SELECT
    dd.user_id,
    COUNT(*)                                                              AS document_count,
    COUNT(*) FILTER (
      WHERE dd.expires_at IS NOT NULL
        AND dd.expires_at <= CURRENT_DATE
    )                                                                     AS expired_document_count,
    COUNT(*) FILTER (
      WHERE dd.expires_at IS NOT NULL
        AND dd.expires_at > CURRENT_DATE
        AND dd.expires_at <= (CURRENT_DATE + INTERVAL '30 days')::DATE
    )                                                                     AS expiring_document_count,
    MIN(dd.expires_at) FILTER (WHERE dd.expires_at IS NOT NULL)           AS earliest_document_expiry
  FROM public.driver_documents dd
  GROUP BY dd.user_id
),
latest_license AS (
  SELECT DISTINCT ON (dd.organization_id, dd.user_id)
    dd.organization_id,
    dd.user_id,
    dd.metadata->>'license_number' AS license_number,
    dd.metadata->>'class' AS license_class,
    dd.expires_at
  FROM public.driver_documents dd
  WHERE dd.doc_type IN ('driver_license', 'license')
  ORDER BY dd.organization_id, dd.user_id, dd.created_at DESC, dd.id
),
compliance_agg AS (
  SELECT
    dce.user_id,
    COUNT(*)                                                              AS compliance_event_count,
    COUNT(*) FILTER (WHERE dce.created_at >= now() - INTERVAL '24 hours') AS compliance_event_count_24h,
    COUNT(*) FILTER (WHERE dce.payload->>'severity' = 'critical')         AS critical_compliance_count,
    MAX(dce.created_at)                                                   AS last_compliance_event_at
  FROM public.driver_compliance_events dce
  GROUP BY dce.user_id
),
hos_agg AS (
  SELECT
    dhos.driver_id,
    COUNT(*)                                                              AS hos_segment_count,
    COUNT(*) FILTER (WHERE dhos.segment_start >= now() - INTERVAL '24 hours') AS hos_segment_count_24h,
    MAX(dhos.segment_start)                                               AS last_active_at
  FROM public.driver_hours_of_service dhos
  GROUP BY dhos.driver_id
),
hos_open AS (
  SELECT DISTINCT ON (dhos.driver_id)
    dhos.driver_id,
    dhos.id            AS open_segment_id,
    dhos.duty_status   AS open_duty_status,
    dhos.segment_start AS open_segment_start
  FROM public.driver_hours_of_service dhos
  WHERE dhos.segment_end IS NULL
  ORDER BY dhos.driver_id, dhos.segment_start DESC
)
SELECT
  dp.id,
  dp.organization_id,
  dp.user_id,
  dp.driver_code,
  dp.status,
  dp.hired_at,
  dp.terminated_at,
  NULLIF(btrim(dp.metadata->>'phone'), '')                        AS phone,
  NULLIF(btrim(dp.metadata->>'emergency_contact_name'), '')        AS emergency_contact_name,
  NULLIF(btrim(dp.metadata->>'emergency_contact_phone'), '')       AS emergency_contact_phone,
  COALESCE(NULLIF(btrim(ll.license_number), ''), NULLIF(btrim(dp.metadata->>'license_number'), '')) AS license_number,
  COALESCE(NULLIF(btrim(ll.license_class), ''), NULLIF(btrim(dp.metadata->>'license_class'), '')) AS license_class,
  COALESCE(ll.expires_at::text, NULLIF(btrim(dp.metadata->>'license_expires_at'), '')) AS license_expires_at,
  dp.created_at,
  dp.updated_at,
  -- Derived: user identity (canonical SSOT projection).
  u.full_name                                                    AS user_full_name,
  u.email                                                        AS user_email,
  -- Derived: active assignment resolution (NULL when unassigned).
  aa.vehicle_id                                                  AS current_vehicle_id,
  aa.branch_id                                                   AS current_branch_id,
  aa.started_at                                                  AS active_assignment_started_at,
  -- Derived: vehicle + branch labels.
  vh.plate_number                                                AS vehicle_plate,
  vh.plate_number                                                AS vehicle_label,
  CASE
    WHEN br.code IS NOT NULL AND br.name IS NOT NULL THEN br.code || ' · ' || br.name
    WHEN br.name IS NOT NULL THEN br.name
    WHEN br.code IS NOT NULL THEN br.code
    ELSE NULL
  END                                                            AS branch_label,
  -- Derived: document counters.
  COALESCE(da.document_count, 0)::INT                            AS document_count,
  COALESCE(da.expired_document_count, 0)::INT                    AS expired_document_count,
  COALESCE(da.expiring_document_count, 0)::INT                   AS expiring_document_count,
  da.earliest_document_expiry                                    AS earliest_document_expiry,
  -- Derived: compliance event counters.
  COALESCE(ca.compliance_event_count, 0)::INT                    AS compliance_event_count,
  COALESCE(ca.compliance_event_count_24h, 0)::INT                AS compliance_event_count_24h,
  COALESCE(ca.critical_compliance_count, 0)::INT                 AS critical_compliance_count,
  ca.last_compliance_event_at,
  -- Derived: hours of service counters.
  COALESCE(ha.hos_segment_count, 0)::INT                         AS hos_segment_count,
  COALESCE(ha.hos_segment_count_24h, 0)::INT                     AS hos_segment_count_24h,
  ha.last_active_at,
  ho.open_segment_id                                             AS hos_active_segment_id,
  ho.open_duty_status                                            AS hos_active_duty_status,
  ho.open_segment_start                                          AS hos_active_segment_started_at,
  -- Derived: status booleans (FE chip vocabulary).
  (dp.status = 'active')                                         AS is_active,
  (dp.status = 'suspended')                                      AS is_suspended,
  (dp.status = 'inactive')                                       AS is_inactive,
  (COALESCE(da.expired_document_count, 0) > 0)                   AS has_expired_documents,
  (COALESCE(da.expiring_document_count, 0) > 0)                  AS has_expiring_documents,
  CASE
    WHEN dp.hired_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - dp.hired_at))::BIGINT
  END                                                            AS tenure_seconds
FROM public.driver_profiles dp
LEFT JOIN public.users u ON u.id = dp.user_id
LEFT JOIN active_assignment aa ON aa.assigned_to_user_id = dp.user_id
LEFT JOIN public.vehicles vh ON vh.id = aa.vehicle_id
LEFT JOIN public.branches br ON br.id = aa.branch_id
LEFT JOIN document_agg da ON da.user_id = dp.user_id
LEFT JOIN latest_license ll ON ll.organization_id = dp.organization_id AND ll.user_id = dp.user_id
LEFT JOIN compliance_agg ca ON ca.user_id = dp.user_id
LEFT JOIN hos_agg ha ON ha.driver_id = dp.id
LEFT JOIN hos_open ho ON ho.driver_id = dp.id;

COMMENT ON VIEW public.v_driver_directory IS
  'FE-friendly projection of driver_profiles with users + vehicle + branch label joins (user_full_name / user_email / vehicle_label / branch_label), active assignment resolution (current_vehicle_id / current_branch_id / active_assignment_started_at), document aggregates (document_count / expired_document_count / expiring_document_count / earliest_document_expiry), compliance lifecycle aggregates (compliance_event_count / compliance_event_count_24h / critical_compliance_count / last_compliance_event_at), HOS aggregates (hos_segment_count / hos_segment_count_24h / last_active_at / hos_active_segment_id / hos_active_duty_status), and status booleans (is_active / is_suspended / is_inactive / has_expired_documents / has_expiring_documents / tenure_seconds). Sources: driver_profiles + users + vehicle_assignments + vehicles + branches + driver_documents + driver_compliance_events + driver_hours_of_service. Read-only; SSOT remains driver_profiles; mutations route through suspend_driver_v1 / restore_driver_v1 / verify_driver_document_v1 / reject_driver_document_v1 / create_driver_compliance_event_v1 / record_hours_of_service_segment_v1.';

REVOKE ALL ON public.v_driver_directory FROM PUBLIC;
REVOKE ALL ON public.v_driver_directory FROM anon;
GRANT SELECT ON public.v_driver_directory TO authenticated;
GRANT SELECT ON public.v_driver_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302710_v_driver_directory'));
COMMIT;
