-- 202605021000_w52_tenant_default_timezone_policy.sql
-- Backend mirror for the W52 FE seed expansion: tenant_default_timezone
-- (apps/console-v2/src/lib/seed-raw/policies.js#sv_370).
--
-- Closes the last network/branches.tsx P3 hardcoding the operator's strict
-- "no fallbacks" reading flagged: the createBranch payload was inlining
-- `timezone: 'Asia/Riyadh'`. The FE now reads strictly from this canonical
-- row; missing canonical row sends an empty string and the backend rejects
-- it with a clear error rather than silently presenting a hardcoded tenant
-- timezone.
--
-- AGENTS.md alignment:
--   §1 SIMPLE/SCALABLE — adding/changing a tenant default timezone is one
--      settings_versions row mutation, no FE source change.
--   §2 ZERO HARDCODING — every tenant-default monetary + timezone surface
--      the FE consumes now reads from a canonical settings row.
--   §3 ROW-DRIVEN — values are rows, not literals.
--   §4 SSOT — three-way alignment: this file ↔ FE seed mirror ↔ modules.
--   §5 APPEND-ONLY — new file; W17 / W43 / W46 / W47 / W48 / W49 untouched.

-- ---------------------------------------------------------------------------
-- 1. settings_category_registry — register the new policy category
-- ---------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  ('tenant_default_timezone',
   'Tenant-scope default IANA timezone for createBranch payloads (consumed by network/branches "New branch" affordance + any tenant-scoped scheduling surface). FE sends `''''` when the canonical row is missing instead of falling back to a hardcoded IANA name; the backend then rejects the empty timezone with a clear error.',
   FALSE, TRUE, 'skip', '["global"]'::jsonb)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- 2. settings_versions — seed canonical global row
-- ---------------------------------------------------------------------------
-- Pattern mirrors W48 (202605020600_w48_*): direct INSERT keyed on
-- (category, scope_type, scope_id, version) with ON CONFLICT idempotency.

INSERT INTO public.settings_versions (
  category,
  scope_type,
  scope_id,
  version,
  value,
  schema_version,
  change_reason,
  approved_at,
  effective_from
)
SELECT
  'tenant_default_timezone',
  'global',
  NULL::uuid,
  1,
  '{"iana":"Asia/Riyadh"}'::jsonb,
  1,
  'W52 canonical tenant default timezone seed',
  now(),
  now()
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = 'tenant_default_timezone'
    AND sv.scope_type = 'global'
    AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
    AND sv.effective_until IS NULL
    AND sv.approved_at IS NOT NULL
);

-- ---------------------------------------------------------------------------
-- 3. settings — write the active resolved row
-- ---------------------------------------------------------------------------
-- Mirror of W48 pattern: settings table holds the single resolved
-- "current" value for a (category, scope_type, scope_id) tuple.

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
  sv.category,
  sv.scope_type,
  sv.scope_id,
  sv.scope_hash,
  sv.id,
  sv.value,
  now()
FROM public.settings_versions sv
WHERE sv.category = 'tenant_default_timezone'
  AND sv.scope_type = 'global'
  AND sv.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  AND sv.effective_until IS NULL
  AND sv.approved_at IS NOT NULL
ORDER BY sv.version DESC, sv.created_at DESC
LIMIT 1
ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;
