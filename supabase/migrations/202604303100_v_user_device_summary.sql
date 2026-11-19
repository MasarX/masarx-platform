-- Spec-Issue: W39 — REAUDIT4/REAUDIT5 PLATFORM P1 carry-forward closure
-- Step: W39-PLATFORM-VIEW-1
-- Migration: paired projection view public.v_user_device_summary.
-- Capability: user_devices.read (read-only; underlying RLS enforced via
--             security_invoker = true).
--
-- Background:
--   The mobile-policy.tsx surface (apps/console-v2/src/modules/platform/
--   mobile-policy.tsx) reads `user_devices` to render the device roster +
--   attestation column. The DeviceRow interface needs `model` and
--   `attestation_status` projections that don't live as top-level columns
--   on `public.user_devices` (W14-7 dropped the FE aliases). Today the FE
--   resolves them through `metadata` jsonb helpers
--   (`modelOf` / `attestationStatusOf` reading
--   `metadata->>'model'` / `metadata->'attestation'->>'status'`) — a
--   workable bridge but not the SSOT closure that the equivalent W23
--   IDENTITY paired projection (`v_user_directory`) provides for users.
--
--   REAUDIT5A/B PLATFORM both flagged this as the last open P1 carry from
--   REAUDIT2 §7 → REAUDIT3 §3.3 → REAUDIT4 §3.2: "DeviceRow paired
--   projection view (`v_user_device_summary`) still missing in canonical
--   migrations". This migration ships the view.
--
-- Remediation:
--   New paired projection view `public.v_user_device_summary` mirroring
--   the W23 paired-projection pattern (security_invoker = true; SELECT to
--   authenticated + service_role; REVOKE from PUBLIC + anon). Surfaces
--   the canonical `public.user_devices` columns + jsonb-projected
--   `model`, `attestation_status`, and `attestation_trusted_at` so the
--   FE row consumer can drop the metadata-helper bridge once the
--   getSupabaseClient() branch in `ui_list_resource_v1` flips.
--
-- Notes:
--   * SSOT remains public.user_devices; this view is read-only.
--   * RLS is enforced via security_invoker = true (the view honours the
--     caller's RLS posture rather than the view-owner's privileges).
--   * GRANTs follow the W23/W28 paired-view convention
--     (anon revoked; authenticated + service_role SELECT).
--   * Idempotent: pure view; safe to re-run via DROP + CREATE.
--
-- Cross-references:
--   - Audit cite: apps/console-v2/__audit__/REAUDIT5B/PLATFORM.md §3.5
--     (P1 carry-forward — DeviceRow `v_user_device_summary` paired view).
--   - Canonical SSOT: supabase/migrations/202601251040_user_devices_v1.sql:46-63.
--   - W23 paired projection pattern reference:
--     supabase/migrations/202604302200_v_user_directory.sql.
--   - W35d security_invoker alignment posture:
--     supabase/migrations/202604302345_w35d_security_invoker_alignment.sql.
--   - FE consumer: apps/console-v2/src/modules/platform/mobile-policy.tsx
--     (DeviceRow → useResourceList<DeviceRow>('user_devices') → swap to
--     `user_device_summary` projection in the same wave).
--   - pgTAP coverage: supabase/tests/pgtap/zzw39_v_user_device_summary.sql.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604303100_v_user_device_summary'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP VIEW IF EXISTS public.v_user_device_summary;

CREATE VIEW public.v_user_device_summary
  WITH (security_invoker = true)
  AS
SELECT
  ud.id,
  ud.organization_id,
  ud.user_id,
  -- Canonical SSOT columns retained (top-level surface).
  ud.device_platform,
  ud.device_identifier_sha256,
  ud.device_label,
  ud.app_version,
  ud.os_version,
  ud.last_seen_at,
  ud.created_at,
  ud.updated_at,
  -- Legacy FE alias projection (matches `DeviceRow.platform` /
  -- `DeviceRow.device_id` shape until the FE drops the alias keys).
  ud.device_platform                                                       AS platform,
  ud.device_identifier_sha256                                              AS device_id,
  -- Projected jsonb fields the FE row consumer needs:
  --   `metadata->>'model'`                              -> model
  --   `metadata->'attestation'->>'status'`              -> attestation_status
  --   `metadata->'attestation'->>'trusted_at'`          -> attestation_trusted_at
  -- These mirror the FE helpers `modelOf` / `attestationStatusOf` /
  -- (the now-removed `trustedAtOf`) without requiring metadata-helper
  -- code on the consumer side once production cuts over.
  (ud.metadata ->> 'model')                                                AS model,
  ((ud.metadata -> 'attestation') ->> 'status')                            AS attestation_status,
  CASE
    WHEN ((ud.metadata -> 'attestation') ->> 'trusted_at') IS NULL THEN NULL
    ELSE (((ud.metadata -> 'attestation') ->> 'trusted_at'))::TIMESTAMPTZ
  END                                                                      AS attestation_trusted_at,
  -- Convenience derived booleans for KPI filters (mirrors the FE
  -- attestationFilter chip vocabulary `trusted | pending | failed | revoked`).
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'trusted')  AS is_attestation_trusted,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'pending')  AS is_attestation_pending,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'failed')   AS is_attestation_failed,
  (LOWER(COALESCE(((ud.metadata -> 'attestation') ->> 'status'), '')) = 'revoked')  AS is_attestation_revoked,
  -- Retain raw metadata so the surface can still inspect the jsonb
  -- (capabilities chip, additional projections in the drawer, etc.).
  ud.metadata                                                              AS metadata
FROM public.user_devices ud;

COMMENT ON VIEW public.v_user_device_summary IS
  'FE-friendly projection of public.user_devices with metadata jsonb projections (model, attestation_status, attestation_trusted_at) and derived attestation booleans (is_attestation_trusted/pending/failed/revoked) for the apps/console-v2/src/modules/platform/mobile-policy.tsx DeviceRow surface. Read-only; SSOT remains user_devices; mutations route through register_user_device_v1 / ui_execute_user_device_revoke_v1. security_invoker = true so RLS evaluates as the invoker (W35d posture). Closes the REAUDIT2/REAUDIT3/REAUDIT4/REAUDIT5 PLATFORM P1 carry-forward (paired projection view previously absent from canonical migrations).';

REVOKE ALL ON public.v_user_device_summary FROM PUBLIC;
REVOKE ALL ON public.v_user_device_summary FROM anon;
GRANT SELECT ON public.v_user_device_summary TO authenticated;
GRANT SELECT ON public.v_user_device_summary TO service_role;

SELECT pg_advisory_unlock(hashtext('202604303100_v_user_device_summary'));
COMMIT;
