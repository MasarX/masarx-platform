-- Console V2 credential directory revoked-status projection repair.
--
-- Revoked provider_auth_configs rows are canonical tombstones:
-- credentials.revoked=true, credentials_vault_id=NULL, expires_at=now().
-- The browser-safe directory must expose status='revoked' instead of
-- collapsing that operator state into the generic expired bucket.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110945_integration_credential_revoked_status_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE VIEW public.v_integration_credential_directory
  WITH (security_invoker = true)
  AS
WITH credential_base AS (
  SELECT
    pac.id,
    pac.provider_id,
    pac.auth_type,
    pac.expires_at,
    pac.created_at,
    p.name AS provider_label,
    p.provider_type AS provider_kind,
    p.metadata->>'vendor' AS provider_vendor,
    p.organization_id AS provider_organization_id,
    COALESCE((pac.credentials->>'revoked')::boolean, FALSE) AS is_revoked
  FROM public.provider_auth_configs pac
  LEFT JOIN public.providers p ON p.id = pac.provider_id
),
credential_rows AS (
  SELECT
    cb.id,
    cb.provider_id,
    cb.auth_type,
    cb.auth_type AS auth_type_label,
    cb.expires_at,
    cb.created_at,
    cb.created_at AS last_rotated_at,
    CASE
      WHEN cb.is_revoked THEN 'revoked'
      WHEN cb.expires_at IS NULL THEN 'active'
      WHEN cb.expires_at <= now() THEN 'expired'
      WHEN cb.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
      ELSE 'active'
    END AS status,
    CASE
      WHEN cb.expires_at IS NULL THEN NULL
      ELSE EXTRACT(DAY FROM (cb.expires_at - now()))::INTEGER
    END AS days_until_expiry,
    cb.provider_label,
    cb.provider_kind,
    cb.provider_vendor,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at > now()
      AND cb.expires_at <= now() + INTERVAL '30 days'
    ) AS is_expiring,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at <= now()
    ) AS is_expired,
    (
      NOT cb.is_revoked
      AND (cb.expires_at IS NULL OR cb.expires_at > now() + INTERVAL '30 days')
    ) AS is_active,
    TRUE AS mask_state,
    cb.provider_organization_id AS organization_id,
    NULL::text AS provider_account_category,
    NULL::text AS company_id,
    NULL::text AS bound_scope_type,
    NULL::uuid AS bound_scope_id,
    NULL::uuid AS bound_settings_version_id,
    0 AS binding_rank
  FROM credential_base cb

  UNION ALL

  SELECT
    cb.id,
    cb.provider_id,
    cb.auth_type,
    cb.auth_type AS auth_type_label,
    cb.expires_at,
    cb.created_at,
    cb.created_at AS last_rotated_at,
    CASE
      WHEN cb.is_revoked THEN 'revoked'
      WHEN cb.expires_at IS NULL THEN 'active'
      WHEN cb.expires_at <= now() THEN 'expired'
      WHEN cb.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
      ELSE 'active'
    END AS status,
    CASE
      WHEN cb.expires_at IS NULL THEN NULL
      ELSE EXTRACT(DAY FROM (cb.expires_at - now()))::INTEGER
    END AS days_until_expiry,
    cb.provider_label,
    cb.provider_kind,
    cb.provider_vendor,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at > now()
      AND cb.expires_at <= now() + INTERVAL '30 days'
    ) AS is_expiring,
    (
      NOT cb.is_revoked
      AND cb.expires_at IS NOT NULL
      AND cb.expires_at <= now()
    ) AS is_expired,
    (
      NOT cb.is_revoked
      AND (cb.expires_at IS NULL OR cb.expires_at > now() + INTERVAL '30 days')
    ) AS is_active,
    TRUE AS mask_state,
    sv.scope_id AS organization_id,
    sv.category AS provider_account_category,
    sv.value->>'company_id' AS company_id,
    sv.scope_type AS bound_scope_type,
    sv.scope_id AS bound_scope_id,
    sv.id AS bound_settings_version_id,
    1 AS binding_rank
  FROM public.settings s
  JOIN public.settings_versions sv ON sv.id = s.settings_version_id
  JOIN credential_base cb ON cb.id::text = sv.value->>'auth_config_id'
  WHERE sv.scope_type = 'tenant'
    AND sv.scope_id IS NOT NULL
    AND NULLIF(sv.value->>'auth_config_id', '') IS NOT NULL
)
SELECT DISTINCT ON (id, organization_id)
  id,
  provider_id,
  auth_type,
  auth_type_label,
  expires_at,
  created_at,
  last_rotated_at,
  status,
  days_until_expiry,
  provider_label,
  provider_kind,
  provider_vendor,
  is_expiring,
  is_expired,
  is_active,
  mask_state,
  organization_id,
  provider_account_category,
  company_id,
  bound_scope_type,
  bound_scope_id,
  bound_settings_version_id
FROM credential_rows
ORDER BY id, organization_id, binding_rank DESC;

COMMENT ON VIEW public.v_integration_credential_directory IS
  'FE-friendly projection of provider_auth_configs. Tenant-bound provider-account settings make global route credentials visible to the owning tenant without exposing credential JSON. Revoked tombstones surface status=revoked instead of expired.';

REVOKE ALL ON public.v_integration_credential_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_credential_directory FROM anon;
GRANT SELECT ON public.v_integration_credential_directory TO authenticated;
GRANT SELECT ON public.v_integration_credential_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605110945_integration_credential_revoked_status_v1'));

COMMIT;
