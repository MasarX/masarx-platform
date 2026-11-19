-- Migration: restore api.resolve_settings_row_from_policy_context_v1 to
--            SECURITY DEFINER (browser-safe wrapper contract)
-- Date: 2026-05-16
-- Spec: MasarX Mobile FieldOps V2 — closes engineering re-audit finding
--   IMPORTANT-2 (docs/ops/evidence/2026-05-16/mobile-v2-fieldops-audit-cycle-2/).
--
--   `public.resolve_settings_row_from_policy_context_v1` is deliberately
--   locked to `service_role` (202601212850_settings_policy_context_resolver_v1).
--   The sanctioned browser-facing path is the `api.*` schema wrapper, which
--   `202605041000_console_v2_live_resource_registry_repair_v1.sql` correctly
--   shipped as SECURITY DEFINER — its own COMMENT documents it as the
--   "Browser-safe api schema wrapper ... used by the FE useResolveSettings()
--   hook".
--
--   `202605100100_console_v2_local_audit_alias_views_v1.sql` re-declared the
--   same wrapper as SECURITY INVOKER. For an `authenticated` caller that
--   fails closed with SQLSTATE 42501: an INVOKER function re-checks EXECUTE
--   on the nested `public.` function as the *caller*, and `authenticated`
--   holds no EXECUTE grant on the locked `public.` resolver. That regressed
--   the documented browser-safe contract and silently broke every
--   authenticated settings resolution (FieldOps `useFieldopsPolicy`,
--   Console `useResolveSettings`) — callers fell back to FE constants.
--
--   This migration restores the wrapper to SECURITY DEFINER. It only
--   forwards to the canonical resolver: no new surface, no schema/RLS
--   change, and `public.resolve_settings_row_from_policy_context_v1` stays
--   service_role-locked. The settings ladder + scope resolution are
--   unchanged.
--
--   AGENTS.md: append-only (no historical migration edited); idempotent
--   (CREATE OR REPLACE); advisory-locked.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605161400_fieldops_settings_resolver_api_wrapper_definer_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_settings_row_from_policy_context_v1(
  p_category TEXT,
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INTEGER,
  scope_path JSONB
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1(p_category, p_context);
$function$;

REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB)
  TO authenticated, service_role;

COMMENT ON FUNCTION api.resolve_settings_row_from_policy_context_v1(TEXT, JSONB) IS
  'Browser-safe SECURITY DEFINER wrapper for public.resolve_settings_row_from_policy_context_v1 (which is service_role-locked). Used by the FE useResolveSettings() / useFieldopsPolicy() hooks. Restored to DEFINER by 202605161400 after 202605100100 regressed it to INVOKER.';

SELECT pg_advisory_unlock(hashtext('202605161400_fieldops_settings_resolver_api_wrapper_definer_v1'));
COMMIT;
