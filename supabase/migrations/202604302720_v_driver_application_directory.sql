-- Spec-Issue: W29 FLEET gap closure (paired projection views)
-- Step: W29-VIEW-3
-- Migration: Canonical projection view public.v_driver_application_directory.
-- Capability: fleet.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-application derived counters + label rollups used by
--   `apps/console-v2/src/modules/operate/fleet/driver-applications.tsx`
--   (DriverApplicationRow).
--
--   Filters `marketplace_participant_requests` to the freelancer_driver
--   subset (`requested_participant_type_key = 'freelancer_driver'`) so the
--   FE consumer no longer needs a client-side filter. Mirrors the W11/W18/
--   W20-W28 paired-projection pattern.
--
--   Derived columns:
--     - reviewer_label             : derived users.full_name JOIN on
--                                      reviewed_by (NULL when not reviewed).
--     - reviewer_email             : derived users.email JOIN on reviewed_by.
--     - capabilities_count         : derived COUNT of jsonb-array elements
--                                      in capabilities_requested.
--     - verification_documents_count
--                                  : derived COUNT of jsonb-array elements
--                                      in verification_documents.
--     - submitted_document_count   : derived COUNT(jsonb_array_elements
--                                      WHERE elem->>'status' = 'submitted').
--     - missing_document_count     : derived COUNT(jsonb_array_elements
--                                      WHERE elem->>'status' = 'missing').
--     - approved_organization_id   : passthrough.
--     - is_pending                 : derived alias for status = 'pending'.
--     - is_approved                : derived alias for status = 'approved'.
--     - is_rejected                : derived alias for status = 'rejected'.
--     - is_withdrawn               : derived alias for status = 'withdrawn'.
--     - is_terminal                : derived BOOLEAN — TRUE when status
--                                      is in ('approved','rejected',
--                                      'withdrawn').
--     - age_seconds                : derived seconds since created_at.
--     - decision_age_seconds       : derived seconds since reviewed_at
--                                      (NULL when not reviewed).
--     - sla_breach                 : derived BOOLEAN — TRUE when
--                                      status='pending' AND
--                                      created_at < now() - INTERVAL '7 days'
--                                      (FE renders the "SLA breach (>7d
--                                      pending)" KPI tile).
--
--   Notes:
--     * SSOT remains public.marketplace_participant_requests; this view is
--       read-only.
--     * RLS is enforced by the underlying tables
--       (marketplace_participant_requests, users) via
--       security_invoker = true.
--     * Service-role + authenticated SELECT (mirrors W22-W28 paired
--       projection grants).
--     * Idempotent: pure view; safe to re-run.
--
-- Cross-references:
--   - SSOT inventory: apps/console-v2/__audit__/SCHEMA-DRIFT/FLEET.md (D1
--     review surface — added in REAUDIT/FLEET.md §D1).
--   - FE shape: apps/console-v2/src/modules/operate/fleet/
--     driver-applications.tsx:65
--   - Canonical table: 202603071100_marketplace_network_foundation_v1.sql:598
--   - Mutation RPC: 202603071120_marketplace_network_rpc_v1.sql:1445
--     (marketplace_participant_request_review_apply_v1).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302720_v_driver_application_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_driver_application_directory;

CREATE VIEW public.v_driver_application_directory
  WITH (security_invoker = true)
  AS
SELECT
  mpr.id,
  mpr.created_at,
  mpr.updated_at,
  mpr.status,
  mpr.review_decision,
  mpr.requested_participant_type_key,
  mpr.requested_by_user_id,
  mpr.requested_organization_id,
  mpr.email,
  mpr.full_name,
  mpr.organization_name,
  mpr.organization_slug,
  mpr.phone,
  mpr.website_url,
  mpr.locale,
  mpr.page_url,
  mpr.referrer,
  mpr.origin,
  mpr.experience_summary,
  mpr.capabilities_requested,
  mpr.verification_documents,
  mpr.marketing,
  mpr.metadata,
  mpr.turnstile_verified,
  mpr.reviewed_at,
  mpr.reviewed_by,
  mpr.review_reason,
  mpr.decision_metadata,
  mpr.approved_organization_id,
  mpr.approved_user_id,
  mpr.approved_participant_profile_id,
  mpr.invite_email_sent_at,
  mpr.invite_redirect_to,
  -- Derived: reviewer identity (NULL when not yet reviewed).
  u.full_name                                                    AS reviewer_label,
  u.email                                                        AS reviewer_email,
  -- Derived: capabilities + documents counts.
  COALESCE(jsonb_array_length(mpr.capabilities_requested), 0)::INT
                                                                 AS capabilities_count,
  COALESCE(jsonb_array_length(mpr.verification_documents), 0)::INT
                                                                 AS verification_documents_count,
  -- Derived: submitted/missing document counts (FE renders these in the
  -- Documents tab and Pending KPI tile).
  (
    SELECT COUNT(*)::INT FROM jsonb_array_elements(mpr.verification_documents) AS d
    WHERE d->>'status' = 'submitted'
  )                                                              AS submitted_document_count,
  (
    SELECT COUNT(*)::INT FROM jsonb_array_elements(mpr.verification_documents) AS d
    WHERE d->>'status' = 'missing'
  )                                                              AS missing_document_count,
  -- Derived: lifecycle booleans (FE chip vocabulary).
  (mpr.status = 'pending')                                       AS is_pending,
  (mpr.status = 'approved')                                      AS is_approved,
  (mpr.status = 'rejected')                                      AS is_rejected,
  (mpr.status = 'withdrawn')                                     AS is_withdrawn,
  (mpr.status IN ('approved', 'rejected', 'withdrawn'))          AS is_terminal,
  -- Derived: age aggregates (FE renders the SLA-breach KPI tile + decision
  -- timeline).
  EXTRACT(EPOCH FROM (now() - mpr.created_at))::BIGINT           AS age_seconds,
  CASE
    WHEN mpr.reviewed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - mpr.reviewed_at))::BIGINT
  END                                                            AS decision_age_seconds,
  (
    mpr.status = 'pending'
    AND mpr.created_at < now() - INTERVAL '7 days'
  )                                                              AS sla_breach
FROM public.marketplace_participant_requests mpr
LEFT JOIN public.users u ON u.id = mpr.reviewed_by
WHERE mpr.requested_participant_type_key = 'freelancer_driver';

COMMENT ON VIEW public.v_driver_application_directory IS
  'FE-friendly projection of marketplace_participant_requests filtered to freelancer_driver applicants, with reviewer label join (reviewer_label / reviewer_email via users.full_name / email), derived counters (capabilities_count / verification_documents_count / submitted_document_count / missing_document_count), lifecycle booleans (is_pending / is_approved / is_rejected / is_withdrawn / is_terminal), and SLA tracking (age_seconds / decision_age_seconds / sla_breach). Sources: marketplace_participant_requests + users. Read-only; SSOT remains marketplace_participant_requests; mutations route through marketplace_participant_request_review_apply_v1 (see 202603071120_marketplace_network_rpc_v1.sql:1445).';

REVOKE ALL ON public.v_driver_application_directory FROM PUBLIC;
REVOKE ALL ON public.v_driver_application_directory FROM anon;
GRANT SELECT ON public.v_driver_application_directory TO authenticated;
GRANT SELECT ON public.v_driver_application_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302720_v_driver_application_directory'));
COMMIT;
