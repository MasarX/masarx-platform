-- Migration: mobile_shell_policy (v2_enabled cutover) v1
-- Date: 2026-05-13
-- Spec: Mobile FieldOps V2 — closes Audit 2 P0 #1
--   (docs/ops/evidence/2026-05-13/mobile-v2-fieldops-parity-audit/README.md).
--
-- Background
-- ----------
-- V2 of the Field Ops mobile shell currently only ships on web via the
-- `?v2=preview` query gate in apps/fieldops/index.ts. Native builds
-- always boot the V1 App.tsx tree, so production native devices have no
-- path into V2 even after every parity / RPC / outbox audit item closed.
--
-- This migration ships a **row-driven, ladder-resolved** opt-in: a new
-- `mobile_shell_policy` settings category with a single boolean
-- (`v2_enabled`) plus an explicit SECURITY DEFINER resolver. Production
-- stays on V1 by default (global default is `v2_enabled = false`); a
-- tenant override flips the cohort to V2 on next app open. Reverting is
-- a single `UPDATE settings_versions ... v2_enabled=false` — no app
-- store release required.
--
-- AGENTS.md compliance posture
-- ----------------------------
-- - Zero hardcoding: cutover is driven entirely by config rows; no role
--   / tenant / platform branches in client code.
-- - Override ladder: resolver uses
--   `public.resolve_settings_row_from_policy_context_v1` so the value
--   resolves Global < Tenant < Client < Sender < Source/Resource. Hub
--   overrides via `public.branches` are supported.
-- - RLS: no new tables. Existing `settings_versions` / `settings`
--   policies remain authoritative.
-- - Audit: resolver `RAISE NOTICE`s are avoided; each call writes a
--   `decision_log` entry (`fieldops_shell_policy_read`) with the
--   correlation id supplied by the caller for end-to-end traceability.
-- - Idempotent: advisory-locked migration; `ON CONFLICT DO NOTHING` for
--   global default seed; `CREATE OR REPLACE FUNCTION` for resolver.
-- - Append-only: new file; no historical migration edits.
--
-- Pattern reference
-- -----------------
-- Mirrors `mobile_attestation_policy` (202602061130) for registry +
-- schema + seed + resolver pattern, and the per-category resolver
-- contract shipped by 202602041725_mobile_ui_policy_resolvers_v1.sql.
-- The resolver returns a JSONB envelope (not a row set) so the FE can
-- call it through supabase-js without an envelope adapter.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605131600_mobile_shell_policy_v2_enabled'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ===========================================================================
-- 1) Settings category registry
-- ===========================================================================

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'mobile_shell_policy',
  'Mobile Field Ops shell-level policy. Controls production cutover from V1 to V2 mobile shell via row-driven v2_enabled flag; resolved through the standard ladder (Global < Tenant < Client < Sender < Source/Resource) so cohorts can opt-in per tenant without an app store release.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

-- ===========================================================================
-- 2) Schema registry (v1)
-- ===========================================================================

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'mobile_shell_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'title', 'Mobile Shell Policy',
    'type', 'object',
    'additionalProperties', TRUE,
    'required', jsonb_build_array('version', 'v2_enabled'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'v2_enabled', jsonb_build_object(
        'type', 'boolean',
        'description', 'When TRUE, native + web shells boot the V2 mobile shell on next app open. Default FALSE keeps production on V1.'
      ),
      'rollout_cohort', jsonb_build_object(
        'type', jsonb_build_array('string', 'null'),
        'description', 'Optional opaque label captured by the FE for telemetry / staged-rollout filtering. Not interpreted server-side.'
      )
    )
  ),
  'Mobile shell-level cutover policy. v2_enabled drives the V1 -> V2 production native cutover (default FALSE).',
  jsonb_build_array(
    jsonb_build_object('version', 1, 'v2_enabled', FALSE, 'rollout_cohort', NULL),
    jsonb_build_object('version', 1, 'v2_enabled', TRUE,  'rollout_cohort', 'pilot-tenant-001')
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active,
  updated_at = now();

-- ===========================================================================
-- 3) Safe global default (v2_enabled = FALSE — production stays on V1)
-- ===========================================================================

WITH defaults AS (
  SELECT jsonb_build_object(
    'version', 1,
    'v2_enabled', FALSE
  ) AS body
),
inserted AS (
  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from,
    created_at
  )
  SELECT
    'mobile_shell_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000'::uuid,
    1,
    defaults.body,
    1,
    'Mobile V2 cutover policy — initial global default (v2_enabled=false)',
    now(),
    now(),
    now()
  FROM defaults
  WHERE NOT EXISTS (
    SELECT 1
    FROM public.settings_versions sv
    WHERE sv.category = 'mobile_shell_policy'
      AND sv.scope_type = 'global'
      AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
      AND sv.effective_until IS NULL
      AND sv.approved_at IS NOT NULL
  )
  RETURNING id, category, scope_type, scope_hash, value
)
INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  scope_hash,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  i.category,
  i.scope_type,
  NULL::uuid,
  i.scope_hash,
  i.id,
  i.value,
  now()
FROM inserted i
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = now();

-- ===========================================================================
-- 4) Category-specific resolver wrapper (row form — matches existing
--    resolve_mobile_*_policy contract; called internally by 5).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy_row(p_context JSONB)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RETURN QUERY
  SELECT *
  FROM public.resolve_settings_row_from_policy_context_v1('mobile_shell_policy', p_context)
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_shell_policy_row(JSONB)
  IS 'Resolve mobile_shell_policy via canonical policy context resolver (resource > source > sender > client > tenant > global). Row form mirrors resolve_mobile_*_policy contract; the envelope form public.resolve_mobile_shell_policy is the FE entry point.';

REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy_row(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy_row(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_shell_policy_row(JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 5) Public envelope resolver — FE entry point.
--    Returns a JSONB envelope keyed by the FE contract:
--      { v2_enabled: boolean, rollout_cohort: text|null, scope_type, scope_id,
--        settings_version_id, version, resolved_at }
--    Defaults to v2_enabled=false on any resolver miss / parse error so a
--    misconfigured policy row cannot brick the boot path. Caller error
--    handling on the FE side is documented in apps/fieldops/App.tsx.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.resolve_mobile_shell_policy(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id      UUID := auth.uid();
  v_caller_org   UUID;
  v_active_role  TEXT := lower(btrim(COALESCE(p_active_role, 'driver')));
  v_in_context   JSONB := COALESCE(p_context, '{}'::jsonb);
  v_resolver_ctx JSONB;
  v_row          RECORD;
  v_value        JSONB := '{}'::jsonb;
  v_v2_enabled   BOOLEAN := FALSE;
  v_rollout      TEXT := NULL;
  v_correlation  UUID;
  v_envelope     JSONB;
  v_now          TIMESTAMPTZ := now();
BEGIN
  -- Defensive: invalid context object falls back to {} so a bad caller
  -- never poisons resolver execution.
  IF jsonb_typeof(v_in_context) <> 'object' THEN
    v_in_context := '{}'::jsonb;
  END IF;

  -- Optional correlation id for audit trace (mirror resolve_fieldops_stop_detail_v1).
  BEGIN
    v_correlation := NULLIF(btrim(COALESCE(v_in_context->>'correlation_id', '')), '')::uuid;
  EXCEPTION WHEN others THEN
    v_correlation := NULL;
  END;

  -- Unauthenticated callers: return the global default. This is the
  -- conservative posture for an authenticated app calling pre-session
  -- (e.g. boot path before sign-in). The default body never enables V2
  -- so this returns the safe `v2_enabled=false` value without leaking
  -- any tenant-scoped override.
  IF v_user_id IS NULL THEN
    v_resolver_ctx := '{}'::jsonb;
  ELSE
    -- Authenticated: resolve against caller's org context. Override the
    -- caller-supplied organization_id with the canonical
    -- current_user_org_id() so a malicious payload cannot probe
    -- foreign tenants.
    v_caller_org := public.current_user_org_id();
    v_resolver_ctx := jsonb_strip_nulls(
      v_in_context
        || jsonb_build_object(
             'organization_id', v_caller_org,
             'user_id',         v_user_id
           )
    );
  END IF;

  -- Resolve via ladder.
  SELECT * INTO v_row
    FROM public.resolve_settings_row_from_policy_context_v1('mobile_shell_policy', v_resolver_ctx)
    LIMIT 1;

  IF FOUND AND v_row.value IS NOT NULL THEN
    v_value := COALESCE(v_row.value, '{}'::jsonb);

    -- Defensive parse: a malformed `v2_enabled` (e.g. set to a string)
    -- must NOT enable V2. Failing closed here means the fail-safe is
    -- "stay on V1".
    BEGIN
      v_v2_enabled := COALESCE((v_value->>'v2_enabled')::boolean, FALSE);
    EXCEPTION WHEN others THEN
      v_v2_enabled := FALSE;
    END;

    v_rollout := NULLIF(btrim(COALESCE(v_value->>'rollout_cohort', '')), '');
  ELSE
    v_v2_enabled := FALSE;
    v_rollout := NULL;
  END IF;

  v_envelope := jsonb_strip_nulls(jsonb_build_object(
    'v2_enabled',          v_v2_enabled,
    'rollout_cohort',      v_rollout,
    'active_role',         v_active_role,
    'scope_type',          COALESCE(v_row.scope_type, 'global'),
    'scope_id',            v_row.scope_id,
    'settings_version_id', v_row.settings_version_id,
    'version',             v_row.version,
    'resolved_at',         v_now
  ));

  -- Audit trail — only when authenticated (anonymous probes don't get
  -- logged, matching the conservative resolver pattern). Errors here
  -- never bubble up; the boot path must never fail because the audit
  -- log was unavailable.
  IF v_user_id IS NOT NULL AND v_caller_org IS NOT NULL THEN
    BEGIN
      PERFORM public.log_decision(
        p_organization_id        := v_caller_org,
        p_decision_category      := 'fieldops_shell_policy_read',
        p_resource_type          := 'mobile_shell',
        p_resource_id            := NULL,
        p_decision_point         := 'resolve_mobile_shell_policy',
        p_decision_outcome       := CASE WHEN v_v2_enabled THEN 'v2' ELSE 'v1' END,
        p_performed_by_system    := 'fieldops_mobile',
        p_correlation_id         := v_correlation,
        p_decision_inputs        := jsonb_strip_nulls(jsonb_build_object(
                                       'active_role',     v_active_role,
                                       'scope_type',      COALESCE(v_row.scope_type, 'global'),
                                       'scope_id',        v_row.scope_id,
                                       'rollout_cohort',  v_rollout
                                     )),
        p_decision_reason        := NULL,
        p_settings_resolution_id := NULL
      );
    EXCEPTION WHEN others THEN
      -- Swallow; resolver must remain non-fatal.
      NULL;
    END;
  END IF;

  RETURN v_envelope;
END;
$function$;

COMMENT ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) IS
  'Mobile shell-level policy resolver. Returns a JSONB envelope { v2_enabled, rollout_cohort, scope_type, ... } used by apps/fieldops/App.tsx to choose between the V1 and V2 shells at boot. Defaults to v2_enabled=false on miss / parse error so V1 stays the safe fallback. Audited via decision_log with correlation_id propagation.';

REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.resolve_mobile_shell_policy(TEXT, JSONB) TO authenticated, service_role;

-- ===========================================================================
-- 6) api.* SECURITY INVOKER mirror for PostgREST.
-- ===========================================================================

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.resolve_mobile_shell_policy(
  p_active_role TEXT DEFAULT 'driver',
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.resolve_mobile_shell_policy(p_active_role, p_context);
$$;

REVOKE ALL ON FUNCTION api.resolve_mobile_shell_policy(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.resolve_mobile_shell_policy(TEXT, JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.resolve_mobile_shell_policy(TEXT, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605131600_mobile_shell_policy_v2_enabled'));
COMMIT;
