-- Plan: Console V2 live-source closure
-- Step: materialize Planning OS and auth-email governance read sources.
--
-- Console V2 already reads these resources through the canonical
-- ui_list_resource_v1 path. This migration adds the missing live relations,
-- updates the stale Planning OS stage settings default to the GitHub Project 6
-- lifecycle, and registers the resources in ui_read_registry without changing
-- the frontend adapter contract.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605041420_console_v2_planning_auth_live_sources_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Planning OS read mirrors. GitHub Project 6 remains the operational SSOT;
--    these tables are the database-backed Console V2 read cache populated by
--    Planning OS automation/service-role sync jobs.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.planning_os_project_items (
  id TEXT PRIMARY KEY,
  project_number INTEGER NOT NULL DEFAULT 6,
  project_url TEXT NOT NULL DEFAULT 'https://github.com/orgs/example-org/projects/1',
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'work_item',
  priority TEXT,
  assignee TEXT,
  spec_issue INTEGER,
  execution_card INTEGER,
  pr INTEGER,
  worker_id TEXT,
  worktree TEXT,
  merged_at TIMESTAMPTZ,
  audit_verdict TEXT,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planning_os_project_items_id_ck CHECK (btrim(id) <> ''),
  CONSTRAINT planning_os_project_items_title_ck CHECK (btrim(title) <> ''),
  CONSTRAINT planning_os_project_items_status_ck CHECK (btrim(status) <> '')
);

CREATE INDEX IF NOT EXISTS idx_planning_os_project_items_status
  ON public.planning_os_project_items (status, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_planning_os_project_items_spec_issue
  ON public.planning_os_project_items (spec_issue)
  WHERE spec_issue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_planning_os_project_items_execution_card
  ON public.planning_os_project_items (execution_card)
  WHERE execution_card IS NOT NULL;

DROP TRIGGER IF EXISTS trg_planning_os_project_items_set_updated_at
  ON public.planning_os_project_items;
CREATE TRIGGER trg_planning_os_project_items_set_updated_at
BEFORE UPDATE ON public.planning_os_project_items
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.planning_os_project_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planning_os_project_items_select ON public.planning_os_project_items;
CREATE POLICY planning_os_project_items_select
  ON public.planning_os_project_items
  FOR SELECT
  TO authenticated
  USING (public.user_has_capability_v1('audit_log.read'));

DROP POLICY IF EXISTS planning_os_project_items_service ON public.planning_os_project_items;
CREATE POLICY planning_os_project_items_service
  ON public.planning_os_project_items
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

REVOKE ALL ON public.planning_os_project_items FROM PUBLIC;
REVOKE ALL ON public.planning_os_project_items FROM anon;
GRANT SELECT ON public.planning_os_project_items TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.planning_os_project_items TO service_role;

COMMENT ON TABLE public.planning_os_project_items IS
  'Console V2 read cache for GitHub Project 6 planning items. GitHub Project 6 is the SSOT; service-role automation refreshes this table.';

CREATE TABLE IF NOT EXISTS public.planning_os_execution_cards (
  id TEXT PRIMARY KEY,
  issue_number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL,
  priority TEXT,
  spec_issue INTEGER,
  work_key TEXT,
  worker_id TEXT,
  worktree TEXT,
  step TEXT,
  claimed_at TIMESTAMPTZ,
  merged_at TIMESTAMPTZ,
  review_policy TEXT,
  source_updated_at TIMESTAMPTZ,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  source_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT planning_os_execution_cards_id_ck CHECK (btrim(id) <> ''),
  CONSTRAINT planning_os_execution_cards_issue_number_ck CHECK (issue_number > 0),
  CONSTRAINT planning_os_execution_cards_title_ck CHECK (btrim(title) <> ''),
  CONSTRAINT planning_os_execution_cards_status_ck CHECK (btrim(status) <> '')
);

CREATE INDEX IF NOT EXISTS idx_planning_os_execution_cards_status
  ON public.planning_os_execution_cards (status, synced_at DESC);
CREATE INDEX IF NOT EXISTS idx_planning_os_execution_cards_spec_issue
  ON public.planning_os_execution_cards (spec_issue)
  WHERE spec_issue IS NOT NULL;

DROP TRIGGER IF EXISTS trg_planning_os_execution_cards_set_updated_at
  ON public.planning_os_execution_cards;
CREATE TRIGGER trg_planning_os_execution_cards_set_updated_at
BEFORE UPDATE ON public.planning_os_execution_cards
FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.planning_os_execution_cards ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS planning_os_execution_cards_select ON public.planning_os_execution_cards;
CREATE POLICY planning_os_execution_cards_select
  ON public.planning_os_execution_cards
  FOR SELECT
  TO authenticated
  USING (public.user_has_capability_v1('audit_log.read'));

DROP POLICY IF EXISTS planning_os_execution_cards_service ON public.planning_os_execution_cards;
CREATE POLICY planning_os_execution_cards_service
  ON public.planning_os_execution_cards
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

REVOKE ALL ON public.planning_os_execution_cards FROM PUBLIC;
REVOKE ALL ON public.planning_os_execution_cards FROM anon;
GRANT SELECT ON public.planning_os_execution_cards TO authenticated, service_role;
GRANT INSERT, UPDATE, DELETE ON public.planning_os_execution_cards TO service_role;

COMMENT ON TABLE public.planning_os_execution_cards IS
  'Console V2 read cache for Planning OS execution-card issues. GitHub issues labeled kind:execution-card remain the SSOT.';

-- ---------------------------------------------------------------------------
-- 2) Planning OS config: replace the stale 6-stage frontend-era default with
--    the current Project 6 lifecycle from scripts/ops/planning-os/config.js.
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  (
    'planning_os_config',
    'Planning OS config (GitHub Project 6 stages, repo and project URL for the Console V2 read-only mirror).',
    TRUE,
    TRUE,
    FALSE,
    'skip',
    '["global","tenant","client","sender","source","resource"]'::jsonb
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES
  (
    'planning_os_config',
    1,
    '{
       "$schema": "http://json-schema.org/draft-07/schema#",
       "title": "Planning OS Config",
       "type": "object",
       "additionalProperties": true,
       "required": ["version", "stages", "github_repo", "github_project_url"],
       "properties": {
         "version": { "type": "integer", "minimum": 1 },
         "stages": { "type": "array", "items": { "type": "string" }, "minItems": 1 },
         "github_repo": { "type": "string", "minLength": 1 },
         "github_project_url": { "type": "string", "format": "uri" }
       }
     }'::jsonb,
    'Planning OS config (GitHub Project 6 stages, repo and project URL for the Console V2 read-only mirror).',
    '[
       {
         "version": 2,
         "stages": ["Inbox", "Needs Detail", "Structured", "Triaged", "Ready for Execution", "Assigned", "In PR", "Blocked", "Done", "Deferred", "Cancelled"],
         "github_repo": "MasarX/MasarX",
         "github_project_url": "https://github.com/orgs/example-org/projects/1"
       }
     ]'::jsonb,
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active;

DO $$
DECLARE
  v_planning_config JSONB := jsonb_build_object(
    'version', 2,
    'stages', jsonb_build_array(
      'Inbox',
      'Needs Detail',
      'Structured',
      'Triaged',
      'Ready for Execution',
      'Assigned',
      'In PR',
      'Blocked',
      'Done',
      'Deferred',
      'Cancelled'
    ),
    'github_repo', 'MasarX/MasarX',
    'github_project_url', 'https://github.com/orgs/example-org/projects/1'
  );
  v_current JSONB;
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'planning_os_config'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS DISTINCT FROM v_planning_config THEN
    PERFORM public.upsert_settings_value_v1(
      'planning_os_config',
      'global',
      NULL,
      v_planning_config,
      1,
      'Refresh Planning OS stages to current GitHub Project 6 lifecycle for Console V2'
    );
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 3) Auth email URL policy: DB-backed read projection over the CI-managed
--    config/ops/auth-email-url-policy.<env>.json contract.
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES
  (
    'auth_email_url_policy',
    'Auth email URL policy mirrored from config/ops/auth-email-url-policy.<env>.json for read-only Console V2 governance.',
    TRUE,
    TRUE,
    FALSE,
    'hard_fail',
    '["global"]'::jsonb
  )
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES
  (
    'auth_email_url_policy',
    1,
    '{
       "$schema": "http://json-schema.org/draft-07/schema#",
       "title": "Auth Email URL Policy",
       "type": "object",
       "additionalProperties": true,
       "required": ["version", "policies"],
       "properties": {
         "version": { "type": "integer", "minimum": 1 },
         "policies": {
           "type": "array",
           "items": {
             "type": "object",
             "additionalProperties": true,
             "required": ["env", "callback_urls", "redirect_urls", "source_file", "audit_status"],
             "properties": {
               "env": { "type": "string", "enum": ["dev", "stg", "prod"] },
               "callback_urls": { "type": "array", "items": { "type": "string" } },
               "redirect_urls": { "type": "array", "items": { "type": "string" } },
               "source_file": { "type": "string", "minLength": 1 },
               "last_audit_at": { "type": ["string", "null"], "format": "date-time" },
               "audit_status": { "type": "string", "enum": ["green", "yellow", "red"] },
               "policy": { "type": "object" },
               "metadata": { "type": "object" }
             }
           }
         }
       }
     }'::jsonb,
    'Auth email URL policy mirrored from config/ops/auth-email-url-policy.<env>.json for read-only Console V2 governance.',
    '[
       {
         "version": 1,
         "policies": [
           {
             "env": "stg",
             "callback_urls": ["https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback"],
             "redirect_urls": ["https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback", "https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback"],
             "source_file": "config/ops/auth-email-url-policy.stg.json",
             "audit_status": "yellow"
           }
         ]
       }
     ]'::jsonb,
    TRUE
  )
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = EXCLUDED.is_active;

DO $$
DECLARE
  v_auth_email_policy JSONB := jsonb_build_object(
    'version', 1,
    'policies', jsonb_build_array(
      jsonb_build_object(
        'env', 'dev',
        'callback_urls', jsonb_build_array('https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback'),
        'redirect_urls', jsonb_build_array(
          'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
          'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'
        ),
        'source_file', 'config/ops/auth-email-url-policy.dev.json',
        'last_audit_at', NULL,
        'audit_status', 'yellow',
        'policy', jsonb_build_object(
          'environment', 'dev',
          'site_url', 'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
          'additional_redirect_urls', jsonb_build_array(
            'https://hrorzpuminkttynstpljzjuu.example.invalid/auth/callback',
            'https://unjijvxjrwurjgsnokovrvom.example.invalid/auth/callback'
          ),
          -- objectives:allow LOCALHOST Justification: auth policy stores loopback hosts as banned redirect values, not allowed runtime endpoints.
          'banned_redirect_hosts', jsonb_build_array('localhost', '127.0.0.1', '0.0.0.0', '.local', '.localhost')
        ),
        'metadata', jsonb_build_object('source', 'config/ops/auth-email-url-policy.dev.json')
      ),
      jsonb_build_object(
        'env', 'stg',
        'callback_urls', jsonb_build_array('https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback'),
        'redirect_urls', jsonb_build_array(
          'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback'
        ),
        'source_file', 'config/ops/auth-email-url-policy.stg.json',
        'last_audit_at', NULL,
        'audit_status', 'yellow',
        'policy', jsonb_build_object(
          'environment', 'stg',
          'site_url', 'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
          'additional_redirect_urls', jsonb_build_array(
            'https://yguwjnwkkqutolgwughjsloj.example.invalid/auth/callback',
            'https://vkhyghkwqoksmtxwrkgqyyxk.example.invalid/auth/callback'
          ),
          -- objectives:allow LOCALHOST Justification: auth policy stores loopback hosts as banned redirect values, not allowed runtime endpoints.
          'banned_redirect_hosts', jsonb_build_array('localhost', '127.0.0.1', '0.0.0.0', '.local', '.localhost')
        ),
        'metadata', jsonb_build_object('source', 'config/ops/auth-email-url-policy.stg.json')
      ),
      jsonb_build_object(
        'env', 'prod',
        'callback_urls', jsonb_build_array('https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback'),
        'redirect_urls', jsonb_build_array(
          'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
          'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback'
        ),
        'source_file', 'config/ops/auth-email-url-policy.prod.json',
        'last_audit_at', NULL,
        'audit_status', 'yellow',
        'policy', jsonb_build_object(
          'environment', 'prod',
          'site_url', 'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
          'additional_redirect_urls', jsonb_build_array(
            'https://vvmruwrtzllojrtomtlgvwju.example.invalid/auth/callback',
            'https://vtgspxqkvhurpwtxnnyvhjzw.example.invalid/auth/callback'
          ),
          -- objectives:allow LOCALHOST Justification: auth policy stores loopback hosts as banned redirect values, not allowed runtime endpoints.
          'banned_redirect_hosts', jsonb_build_array('localhost', '127.0.0.1', '0.0.0.0', '.local', '.localhost')
        ),
        'metadata', jsonb_build_object('source', 'config/ops/auth-email-url-policy.prod.json')
      )
    )
  );
  v_current JSONB;
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'auth_email_url_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS DISTINCT FROM v_auth_email_policy THEN
    PERFORM public.upsert_settings_value_v1(
      'auth_email_url_policy',
      'global',
      NULL,
      v_auth_email_policy,
      1,
      'Seed auth email URL policy mirror from config/ops/auth-email-url-policy.<env>.json'
    );
  END IF;
END $$;

CREATE OR REPLACE FUNCTION public.auth_email_url_policy_rows_v1()
RETURNS TABLE (
  env TEXT,
  callback_urls TEXT[],
  redirect_urls TEXT[],
  source_file TEXT,
  last_audit_at TIMESTAMPTZ,
  audit_status TEXT,
  policy JSONB,
  metadata JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_value JSONB;
BEGIN
  PERFORM public.assert_capability_v1('settings.read', v_scope_type, v_scope_id);
  v_value := public.resolve_settings_merged('auth_email_url_policy', v_scope_type, v_scope_id);

  IF v_value IS NULL OR jsonb_typeof(v_value->'policies') IS DISTINCT FROM 'array' THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    p.policy_doc->>'env' AS env,
    ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(p.policy_doc->'callback_urls', '[]'::jsonb))
    ) AS callback_urls,
    ARRAY(
      SELECT jsonb_array_elements_text(COALESCE(p.policy_doc->'redirect_urls', '[]'::jsonb))
    ) AS redirect_urls,
    p.policy_doc->>'source_file' AS source_file,
    NULLIF(p.policy_doc->>'last_audit_at', '')::timestamptz AS last_audit_at,
    COALESCE(NULLIF(p.policy_doc->>'audit_status', ''), 'yellow') AS audit_status,
    COALESCE(p.policy_doc->'policy', '{}'::jsonb) AS policy,
    COALESCE(p.policy_doc->'metadata', '{}'::jsonb) AS metadata
  FROM jsonb_array_elements(v_value->'policies') AS p(policy_doc)
  WHERE COALESCE(NULLIF(p.policy_doc->>'env', ''), '') <> '';
END;
$function$;

REVOKE ALL ON FUNCTION public.auth_email_url_policy_rows_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.auth_email_url_policy_rows_v1() FROM anon;
GRANT EXECUTE ON FUNCTION public.auth_email_url_policy_rows_v1() TO authenticated, service_role;

COMMENT ON FUNCTION public.auth_email_url_policy_rows_v1() IS
  'Browser-safe read projection for auth_email_url_policy settings. Enforces settings.read and returns rows for Console V2.';

CREATE OR REPLACE VIEW public.auth_email_url_policy
WITH (security_invoker = true) AS
SELECT *
FROM public.auth_email_url_policy_rows_v1();

REVOKE ALL ON public.auth_email_url_policy FROM PUBLIC;
REVOKE ALL ON public.auth_email_url_policy FROM anon;
GRANT SELECT ON public.auth_email_url_policy TO authenticated, service_role;

COMMENT ON VIEW public.auth_email_url_policy IS
  'Console V2 read-only view of auth email URL policy rows from auth_email_url_policy settings.';

-- ---------------------------------------------------------------------------
-- 4) Register all three resources in ui_read_registry.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_existing_resources JSONB;
  v_resources JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'planning_os_project_items',
      'relation', 'public.planning_os_project_items',
      'id_column', 'id',
      'capability_read', 'audit_log.read',
      'default_sort', jsonb_build_object('column', 'synced_at', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'kind', 'column', 'kind', 'op', 'eq'),
        jsonb_build_object('key', 'priority', 'column', 'priority', 'op', 'eq'),
        jsonb_build_object('key', 'worker_id', 'column', 'worker_id', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'planning_os_execution_cards',
      'relation', 'public.planning_os_execution_cards',
      'id_column', 'id',
      'capability_read', 'audit_log.read',
      'default_sort', jsonb_build_object('column', 'issue_number', 'direction', 'desc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
        jsonb_build_object('key', 'priority', 'column', 'priority', 'op', 'eq'),
        jsonb_build_object('key', 'worker_id', 'column', 'worker_id', 'op', 'eq'),
        jsonb_build_object('key', 'spec_issue', 'column', 'spec_issue', 'op', 'eq')
      )
    ),
    jsonb_build_object(
      'key', 'auth_email_url_policy',
      'relation', 'public.auth_email_url_policy',
      'id_column', 'env',
      'capability_read', 'settings.read',
      'default_sort', jsonb_build_object('column', 'env', 'direction', 'asc'),
      'filters', jsonb_build_array(
        jsonb_build_object('key', 'env', 'column', 'env', 'op', 'eq'),
        jsonb_build_object('key', 'audit_status', 'column', 'audit_status', 'op', 'eq')
      )
    )
  );
  v_next JSONB;
BEGIN
  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
    INTO v_existing_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item
   WHERE item->>'key' NOT IN (
     'planning_os_project_items',
     'planning_os_execution_cards',
     'auth_email_url_policy'
   );

  v_next := jsonb_set(
    v_current,
    '{resources}',
    COALESCE(v_existing_resources, '[]'::jsonb) || v_resources,
    true
  );

  IF v_next IS DISTINCT FROM v_current THEN
    PERFORM public.upsert_settings_value_v1(
      'ui_read_registry',
      'global',
      NULL,
      v_next,
      1,
      'Register Console V2 Planning OS and auth-email governance live resources'
    );
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605041420_console_v2_planning_auth_live_sources_v1'));

COMMIT;
