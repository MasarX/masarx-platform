-- Spec-Issue: W23 IDENTITY gap closure (paired projection views)
-- Step: W23-VIEW-3
-- Migration: Canonical projection view public.v_tenant_signup_request_summary.
-- Capability: tenant_signup_requests.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-request derived rollups + attestation completeness used by
--   `apps/console-v2/src/modules/platform/organizations.tsx`
--   (TenantSignupRequestRow surface — Signup queue + drawer):
--     - reviewer_label              : derived from users.full_name on
--                                     reviewed_by FK (NULL when not yet
--                                     reviewed). FE drawer currently
--                                     reads `reviewed_by_label` synthetic
--                                     alias; the view exposes both names.
--     - reviewer_email              : derived from users.email on
--                                     reviewed_by FK
--     - approved_organization_label : derived from organizations.name on
--                                     approved_organization_id FK
--     - approved_user_email         : derived from users.email on
--                                     approved_user_id FK
--     - attestation_count           : COUNT(jsonb keys at metadata.attestations)
--     - attestation_passed_count    : COUNT(jsonb keys at metadata.attestations
--                                     where the value is TRUE)
--     - attestation_complete        : derived BOOLEAN — TRUE when all
--                                     attestation keys are present AND TRUE
--                                     AND turnstile_verified is TRUE
--     - has_marketing_consent       : derived BOOLEAN — marketing.consent
--                                     is TRUE
--     - is_pending                  : derived BOOLEAN — status='pending'
--     - is_approved                 : derived BOOLEAN — status='approved'
--     - is_rejected                 : derived BOOLEAN — status='rejected'
--     - decision_age_seconds        : EXTRACT(EPOCH FROM (now() - reviewed_at))
--                                     when reviewed; NULL when pending.
--
--   The FE `TenantSignupRequestRow` interface in
--   `apps/console-v2/src/modules/platform/organizations.tsx` keeps the
--   canonical schema fields (organization_name, email, full_name,
--   marketing, metadata, attestations envelope) AND the legacy demo
--   aliases (org_name, industry, size, contact_email, received_at) for
--   the queue table. Moving the rollups onto a canonical view exposes
--   both the canonical SSOT columns and the FE-shaped derived booleans
--   on the same seam, so the production cutover becomes a single
--   getSupabaseClient() branch flip in
--   `ui_list_resource_v1('tenant_signup_request_summary')`.
--
-- Notes:
--   * SSOT remains public.tenant_signup_requests; this view is read-only.
--   * RLS is enforced by the underlying tables (tenant_signup_requests,
--     users, organizations).
--   * Service-role + authenticated SELECT (mirrors W20/W21/W22 paired
--     projection grants).
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302220_v_tenant_signup_request_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_tenant_signup_request_summary;

CREATE VIEW public.v_tenant_signup_request_summary AS
SELECT
  t.id,
  t.created_at,
  t.updated_at,
  t.status,
  t.review_decision,
  t.email,
  t.full_name,
  t.organization_name,
  t.organization_slug,
  t.website_url,
  t.phone,
  t.notes,
  t.locale,
  t.page_url,
  t.referrer,
  t.origin,
  t.marketing,
  t.metadata,
  t.ip_hash,
  t.turnstile_verified,
  t.reviewed_at,
  t.reviewed_by,
  t.review_reason,
  t.decision_metadata,
  t.approved_organization_id,
  t.approved_user_id,
  t.approved_auth_user_id,
  t.invite_email_sent_at,
  t.invite_redirect_to,
  t.last_error_code,
  t.last_error_message,
  t.last_error_at,
  -- Reviewer projections
  ru.full_name                                    AS reviewer_label,
  ru.email                                        AS reviewer_email,
  -- Approved-org / approved-user projections
  ao.name                                         AS approved_organization_label,
  au.email                                        AS approved_user_email,
  -- Attestation rollups (jsonb walk over metadata.attestations object)
  COALESCE(jsonb_attestations.attestation_count, 0)         AS attestation_count,
  COALESCE(jsonb_attestations.attestation_passed_count, 0)  AS attestation_passed_count,
  -- Attestation complete: every attestation key is TRUE AND turnstile passed.
  (
    COALESCE(jsonb_attestations.attestation_count, 0) > 0
    AND COALESCE(jsonb_attestations.attestation_count, 0)
        = COALESCE(jsonb_attestations.attestation_passed_count, 0)
    AND COALESCE(t.turnstile_verified, FALSE) = TRUE
  )                                                          AS attestation_complete,
  -- Marketing consent flag (marketing.consent IS TRUE)
  COALESCE((t.marketing->>'consent')::BOOLEAN, FALSE)        AS has_marketing_consent,
  -- Status booleans
  (t.status = 'pending')                                     AS is_pending,
  (t.status = 'approved')                                    AS is_approved,
  (t.status = 'rejected')                                    AS is_rejected,
  -- Decision age (seconds since review)
  CASE
    WHEN t.reviewed_at IS NOT NULL THEN
      EXTRACT(EPOCH FROM (now() - t.reviewed_at))::INT
    ELSE NULL
  END                                                        AS decision_age_seconds
FROM public.tenant_signup_requests t
LEFT JOIN public.users ru ON ru.id = t.reviewed_by
LEFT JOIN public.organizations ao ON ao.id = t.approved_organization_id
LEFT JOIN public.users au ON au.id = t.approved_user_id
LEFT JOIN LATERAL (
  SELECT
    COUNT(*)::INT                                                  AS attestation_count,
    COUNT(*) FILTER (WHERE (att.value)::BOOLEAN = TRUE)::INT       AS attestation_passed_count
  FROM jsonb_each(COALESCE(t.metadata->'attestations', '{}'::jsonb)) AS att
  WHERE jsonb_typeof(att.value) = 'boolean'
) AS jsonb_attestations ON TRUE;

COMMENT ON VIEW public.v_tenant_signup_request_summary IS
  'FE-friendly projection of tenant_signup_requests with reviewer joins (reviewer_label, reviewer_email), approved-entity joins (approved_organization_label, approved_user_email), attestation rollups (attestation_count, attestation_passed_count, attestation_complete), marketing consent flag, status booleans (is_pending, is_approved, is_rejected), and decision_age_seconds. Sources: tenant_signup_requests + users + organizations. Read-only; SSOT remains tenant_signup_requests; mutations go through tenant_signup_review_apply_v1.';

REVOKE ALL ON public.v_tenant_signup_request_summary FROM PUBLIC;
REVOKE ALL ON public.v_tenant_signup_request_summary FROM anon;
REVOKE ALL ON public.v_tenant_signup_request_summary FROM authenticated;
GRANT SELECT ON public.v_tenant_signup_request_summary TO authenticated;
GRANT SELECT ON public.v_tenant_signup_request_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302220_v_tenant_signup_request_summary'));
COMMIT;
