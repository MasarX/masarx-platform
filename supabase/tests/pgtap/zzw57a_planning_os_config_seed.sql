-- Spec-Issue: W57-A console-v2 frontend-design backend closure — planning_os_config
-- pgTAP: validates the canonical `planning_os_config` settings policy seed
-- shipped by supabase/migrations/202605021300_w57a_planning_os_config_seed.sql.
--
-- Asserts (8 total):
--   1. settings_category_registry row exists with requires_schema=TRUE,
--      requires_global_default=TRUE.
--   2. schema_registry active row (is_active=TRUE) exists at version 1.
--   3. settings_versions current global row exists (effective_until IS NULL,
--      approved_at IS NOT NULL, version=1).
--   4. settings projection global row exists.
--   5. resolve_settings('planning_os_config', NULL, NULL) returns
--      github_repo = 'MasarX/MasarX'.
--   6. resolve_settings('planning_os_config', NULL, NULL) returns
--      github_project_url = 'https://github.com/orgs/example-org/projects/1'.
--   7. resolve_settings('planning_os_config', NULL, NULL).stages includes
--      'Draft' (canonical first stage).
--   8. resolve_settings('planning_os_config', NULL, NULL).stages length = 6
--      (canonical kanban column count: Draft / Triaged / Ready for Execution
--      / In Progress / Done / Audit Pending).
--
-- FE consumer:
--   - apps/console-v2/src/modules/platform/planning-os.tsx
--     `useResolveSettings('planning_os_config', undefined)` reads stages,
--     github_repo, github_project_url; the module renders a loud StateView
--     "Canonical planning_os_config not seeded" error if any value is
--     missing/empty. These assertions guarantee the production guard never
--     fires when this migration is applied.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

-- 1) settings_category_registry presence + flags.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_category_registry
    WHERE category = 'planning_os_config'
      AND requires_schema = TRUE
      AND requires_global_default = TRUE
  ),
  'planning_os_config: settings_category_registry row exists with requires_schema/requires_global_default'
);

-- 2) schema_registry active row at version 1.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'planning_os_config'
      AND version = 1
      AND is_active = TRUE
  ),
  'planning_os_config: schema_registry version 1 active row exists'
);

-- 3) settings_versions current global row carries the current Project 6 config.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings_versions
    WHERE category = 'planning_os_config'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND value->>'version' = '2'
      AND effective_until IS NULL
      AND approved_at IS NOT NULL
  ),
  'planning_os_config: settings_versions current global row exists with current Project 6 config version'
);

-- 4) settings projection row.
SELECT ok(
  EXISTS (
    SELECT 1 FROM public.settings
    WHERE category = 'planning_os_config'
      AND scope_type = 'global'
      AND scope_id IS NULL
  ),
  'planning_os_config: settings projection global row exists'
);

-- 5) Resolver scalar spot-check: github_repo.
SELECT is(
  (public.resolve_settings('planning_os_config', NULL, NULL))->>'github_repo',
  'MasarX/MasarX',
  'resolve_settings(planning_os_config).github_repo = MasarX/MasarX'
);

-- 6) Resolver scalar spot-check: github_project_url.
SELECT is(
  (public.resolve_settings('planning_os_config', NULL, NULL))->>'github_project_url',
  'https://github.com/orgs/example-org/projects/1',
  'resolve_settings(planning_os_config).github_project_url = https://github.com/orgs/example-org/projects/1'
);

-- 7) Resolver stages array contains canonical first stage.
SELECT ok(
  (public.resolve_settings('planning_os_config', NULL, NULL))->'stages' @> '["Inbox"]'::jsonb,
  'resolve_settings(planning_os_config).stages contains "Inbox"'
);

-- 8) Resolver stages array length matches canonical kanban column count.
SELECT is(
  jsonb_array_length((public.resolve_settings('planning_os_config', NULL, NULL))->'stages'),
  11,
  'resolve_settings(planning_os_config).stages has 11 canonical Project 6 stages'
);

SELECT finish();

ROLLBACK;
