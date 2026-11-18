-- Driver application directory must expose fleet handoff readback.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605301145_driver_application_directory_fleet_handoff_v1'));
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
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'type', CASE WHEN jsonb_typeof(doc->'type') = 'string' THEN doc->'type' END,
      'ref', CASE WHEN jsonb_typeof(doc->'ref') = 'string' THEN doc->'ref' END,
      'issued_at', CASE WHEN jsonb_typeof(doc->'issued_at') = 'string' THEN doc->'issued_at' END,
      'expires_at', CASE WHEN jsonb_typeof(doc->'expires_at') = 'string' THEN doc->'expires_at' END,
      'status', CASE WHEN jsonb_typeof(doc->'status') = 'string' THEN doc->'status' END
    ) ORDER BY ordinal)
    FROM jsonb_array_elements(mpr.verification_documents) WITH ORDINALITY AS documents(doc, ordinal)
  ), '[]'::jsonb) AS verification_documents,
  CASE WHEN jsonb_typeof(mpr.marketing->'utm_source') = 'string' THEN mpr.marketing->>'utm_source' END AS utm_source,
  CASE WHEN jsonb_typeof(mpr.marketing->'utm_campaign') = 'string' THEN mpr.marketing->>'utm_campaign' END AS utm_campaign,
  CASE WHEN jsonb_typeof(mpr.metadata->'source') = 'string' THEN mpr.metadata->>'source' END AS intake_source,
  CASE WHEN jsonb_typeof(mpr.metadata->'ip_country') = 'string' THEN mpr.metadata->>'ip_country' END AS ip_country,
  CASE WHEN jsonb_typeof(mpr.metadata->'dedupe_hint') = 'string' THEN mpr.metadata->>'dedupe_hint' END AS dedupe_hint,
  mpr.turnstile_verified,
  mpr.reviewed_at,
  mpr.reviewed_by,
  mpr.review_reason,
  COALESCE((
    SELECT jsonb_object_agg(key, value)
    FROM jsonb_each(CASE WHEN jsonb_typeof(mpr.decision_metadata) = 'object'
                         THEN mpr.decision_metadata ELSE '{}'::jsonb END) AS decision(key, value)
    WHERE (key IN ('note', 'reason', 'review_applied_at') AND jsonb_typeof(value) = 'string')
       OR (key = 'request_additional_docs' AND jsonb_typeof(value) = 'boolean')
  ), '{}'::jsonb) || jsonb_strip_nulls(jsonb_build_object('requested_documents', (
    SELECT jsonb_agg(value ORDER BY ordinal)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(mpr.decision_metadata->'requested_documents') = 'array'
                                  THEN mpr.decision_metadata->'requested_documents' ELSE '[]'::jsonb END)
      WITH ORDINALITY AS requests(value, ordinal)
    WHERE jsonb_typeof(value) = 'string'
  ))) AS decision_metadata,
  mpr.approved_organization_id,
  mpr.approved_user_id,
  mpr.approved_participant_profile_id,
  mpr.invite_email_sent_at,
  mpr.invite_redirect_to,
  u.full_name AS reviewer_label,
  u.email AS reviewer_email,
  COALESCE(jsonb_array_length(mpr.capabilities_requested), 0)::INT AS capabilities_count,
  COALESCE(jsonb_array_length(mpr.verification_documents), 0)::INT AS verification_documents_count,
  (
    SELECT COUNT(*)::INT
      FROM jsonb_array_elements(mpr.verification_documents) AS d
     WHERE d->>'status' = 'submitted'
  ) AS submitted_document_count,
  (
    SELECT COUNT(*)::INT
      FROM jsonb_array_elements(mpr.verification_documents) AS d
     WHERE d->>'status' = 'missing'
  ) AS missing_document_count,
  (mpr.status = 'pending') AS is_pending,
  (mpr.status = 'approved') AS is_approved,
  (mpr.status = 'rejected') AS is_rejected,
  (mpr.status = 'withdrawn') AS is_withdrawn,
  (mpr.status IN ('approved', 'rejected', 'withdrawn')) AS is_terminal,
  EXTRACT(EPOCH FROM (now() - mpr.created_at))::BIGINT AS age_seconds,
  CASE
    WHEN mpr.reviewed_at IS NULL THEN NULL
    ELSE EXTRACT(EPOCH FROM (now() - mpr.reviewed_at))::BIGINT
  END AS decision_age_seconds,
  (
    mpr.status = 'pending'
    AND mpr.created_at < now() - INTERVAL '7 days'
  ) AS sla_breach,
  dp.id AS driver_profile_id,
  dp.status AS fleet_driver_status,
  (
    mpr.status = 'approved'
    AND dp.id IS NOT NULL
  ) AS fleet_handoff_ready,
  COALESCE((
    SELECT COUNT(*)::INT
      FROM public.driver_documents dd
     WHERE dd.organization_id = mpr.approved_organization_id
       AND dd.user_id = mpr.approved_user_id
       AND dd.metadata->>'marketplace_request_id' = mpr.id::text
  ), 0) AS fleet_document_count,
  COALESCE((
    SELECT COUNT(*)::INT
      FROM public.driver_compliance_events dce
     WHERE dce.organization_id = mpr.approved_organization_id
       AND dce.user_id = mpr.approved_user_id
       AND dce.event_type = 'marketplace_driver_approved'
       AND dce.payload->>'marketplace_request_id' = mpr.id::text
  ), 0) AS fleet_compliance_event_count,
  (
    SELECT MAX(dce.created_at)
      FROM public.driver_compliance_events dce
     WHERE dce.organization_id = mpr.approved_organization_id
       AND dce.user_id = mpr.approved_user_id
       AND dce.event_type = 'marketplace_driver_approved'
       AND dce.payload->>'marketplace_request_id' = mpr.id::text
  ) AS fleet_last_compliance_event_at
FROM public.marketplace_participant_requests mpr
LEFT JOIN public.users u ON u.id = mpr.reviewed_by
LEFT JOIN public.driver_profiles dp
  ON dp.organization_id = mpr.approved_organization_id
 AND dp.user_id = mpr.approved_user_id
WHERE mpr.requested_participant_type_key = 'freelancer_driver';

COMMENT ON VIEW public.v_driver_application_directory IS
  'FE-friendly projection of marketplace_participant_requests filtered to freelancer_driver applicants, with reviewer label joins, application counters, lifecycle booleans, SLA tracking, and approved fleet handoff readback (driver_profile_id, fleet_driver_status, fleet_document_count, fleet_compliance_event_count). Sources: marketplace_participant_requests + users + driver_profiles + driver_documents + driver_compliance_events. Read-only; SSOT remains marketplace_participant_requests and fleet driver tables; mutations route through marketplace_participant_request_review_apply_v1.';

REVOKE ALL ON public.v_driver_application_directory FROM PUBLIC;
REVOKE ALL ON public.v_driver_application_directory FROM anon;
GRANT SELECT ON public.v_driver_application_directory TO authenticated;
GRANT SELECT ON public.v_driver_application_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605301145_driver_application_directory_fleet_handoff_v1'));

COMMIT;
