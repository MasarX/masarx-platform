-- Spec-Issue: W27 INTEGRATIONS gap closure (paired projection views)
-- Step: W27-VIEW-4
-- Migration: Canonical projection view public.v_integration_credential_directory.
-- Capability: integrations.read (read-only; underlying RLS enforced)
--
-- Purpose:
--   Project per-credential derived joins + status flags used by
--   `apps/console-v2/src/modules/integrations/credentials.tsx`
--   (ProviderAuthConfigRaw / ProviderAuthConfig):
--     - status               : derived enum {active, expiring, expired, revoked,
--                                unknown} from expires_at + now() (closes W18-4
--                                §11 derivation by surfacing as a canonical
--                                column shadow)
--     - last_rotated_at      : alias for canonical `created_at` (FE retains the
--                                `last_rotated_at` UI vocabulary; canonical
--                                table has no rotation history yet)
--     - days_until_expiry    : derived (expires_at - now())::days
--     - provider_label       : derived from providers.name
--     - provider_kind        : derived from providers.provider_type
--     - provider_vendor      : derived from providers.metadata->>'vendor'
--     - is_expiring          : derived flag (expires_at within 30 days)
--     - is_expired           : derived flag (expires_at <= now())
--     - is_active            : derived flag (status='active')
--     - mask_state           : derived flag (always TRUE for FE; canonical
--                                stores credentials JSONB and never returns
--                                plaintext via this view — placeholder for
--                                future per-tenant masking policy)
--     - auth_type_label      : alias for canonical `auth_type` (FE retains
--                                pretty-printable label)
--
--   The FE `ProviderAuthConfigRaw` interface at
--   apps/console-v2/src/modules/integrations/credentials.tsx carries:
--     - status, last_rotated_at as derived projection annotations (W18-4 §11
--       deferral). This view exposes both canonical SSOT columns AND derived
--       status under stable view keys so live cutover stays a single
--       getSupabaseClient() branch flip.
--
-- Notes:
--   * SSOT remains public.provider_auth_configs; this view is read-only.
--   * `credentials JSONB` is intentionally NOT exposed in this view (security
--     posture). The FE renders only the masked auth_type chip and rotation
--     history; secret material stays service-role-only.
--   * RLS enforced via `security_invoker = true`.
--   * Service-role + authenticated SELECT.
--   * Idempotent: pure view; safe to re-run.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604302530_v_integration_credential_directory'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_integration_credential_directory;

CREATE VIEW public.v_integration_credential_directory
  WITH (security_invoker = true)
  AS
SELECT
  pac.id,
  pac.provider_id,
  pac.auth_type,
  pac.auth_type AS auth_type_label,
  pac.expires_at,
  pac.created_at,
  -- FE alias shadow: last_rotated_at falls back to created_at (no rotation
  -- history table yet). Live cutover replaces with canonical
  -- provider_auth_config_rotations.MAX(created_at) when shipped.
  pac.created_at AS last_rotated_at,
  -- Derived: status enum from expires_at + now() (single SSOT for FE chip)
  CASE
    WHEN pac.expires_at IS NULL THEN 'active'
    WHEN pac.expires_at <= now() THEN 'expired'
    WHEN pac.expires_at <= now() + INTERVAL '30 days' THEN 'expiring'
    ELSE 'active'
  END AS status,
  -- Derived: days until expiry (NULL when no expiry; negative when expired)
  CASE
    WHEN pac.expires_at IS NULL THEN NULL
    ELSE EXTRACT(DAY FROM (pac.expires_at - now()))::INTEGER
  END AS days_until_expiry,
  -- Derived: provider label resolution
  p.name              AS provider_label,
  p.provider_type     AS provider_kind,
  p.metadata->>'vendor' AS provider_vendor,
  -- Derived: status flags (single SSOT for FE chip + KPI tile rendering)
  (pac.expires_at IS NOT NULL
    AND pac.expires_at > now()
    AND pac.expires_at <= now() + INTERVAL '30 days') AS is_expiring,
  (pac.expires_at IS NOT NULL AND pac.expires_at <= now()) AS is_expired,
  (pac.expires_at IS NULL OR pac.expires_at > now() + INTERVAL '30 days') AS is_active,
  -- Mask-state placeholder; reserved for future per-tenant policy.
  TRUE AS mask_state
FROM public.provider_auth_configs pac
LEFT JOIN public.providers p ON p.id = pac.provider_id;

COMMENT ON VIEW public.v_integration_credential_directory IS
  'FE-friendly projection of provider_auth_configs with derived status enum (active/expiring/expired from expires_at + now()), provider label resolution (provider_label, provider_kind, provider_vendor via providers + metadata.vendor), days_until_expiry derivation, last_rotated_at alias (falls back to created_at until rotation history table ships), and status flags (is_expiring, is_expired, is_active). Excludes the credentials JSONB (security posture: secret material stays service-role-only). Sources: provider_auth_configs + providers. Read-only; SSOT remains provider_auth_configs; mutations go through integration_plugin_rotate_credentials_v1 / ui_revoke_provider_auth_config_v1.';

REVOKE ALL ON public.v_integration_credential_directory FROM PUBLIC;
REVOKE ALL ON public.v_integration_credential_directory FROM anon;
GRANT SELECT ON public.v_integration_credential_directory TO authenticated;
GRANT SELECT ON public.v_integration_credential_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202604302530_v_integration_credential_directory'));
COMMIT;
