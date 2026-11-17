-- Plan: PLAN-202601-last-mile-enterprise-readiness-v2 / Step: S04
-- Migration: Guard api contract view regeneration from widening service-only config views
-- Why:
--   - `api` is the PostgREST-exposed contract schema (views + RPC).
--   - Some `api.*` views are intentionally service-role-only (ops tooling/config cache).
--   - A dynamic contract-view regeneration must not widen grants on those service-only views.
-- What:
--   - Add SSOT registry table: public.api_contract_view_exclusions (row-driven).
--   - Patch public.refresh_api_contract_views_v1() to skip excluded views.
--   - Re-assert service-only view definitions + least-privilege grants.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) SSOT registry: service-only `api.*` views excluded from grant mirroring
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.api_contract_view_exclusions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  schema_name TEXT NOT NULL DEFAULT 'api',
  view_name TEXT NOT NULL,
  reason TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT api_contract_view_exclusions_schema_nonempty CHECK (btrim(schema_name) <> ''),
  CONSTRAINT api_contract_view_exclusions_view_nonempty CHECK (btrim(view_name) <> ''),
  CONSTRAINT api_contract_view_exclusions_unique UNIQUE (schema_name, view_name)
);

COMMENT ON TABLE public.api_contract_view_exclusions IS
  'SSOT: api view names excluded from dynamic contract-view regeneration (service-only views).';

ALTER TABLE public.api_contract_view_exclusions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.api_contract_view_exclusions FROM PUBLIC;
REVOKE ALL ON TABLE public.api_contract_view_exclusions FROM anon;
REVOKE ALL ON TABLE public.api_contract_view_exclusions FROM authenticated;

DROP POLICY IF EXISTS api_contract_view_exclusions_service_policy ON public.api_contract_view_exclusions;
CREATE POLICY api_contract_view_exclusions_service_policy
  ON public.api_contract_view_exclusions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP TRIGGER IF EXISTS trg_api_contract_view_exclusions_set_updated_at ON public.api_contract_view_exclusions;
CREATE TRIGGER trg_api_contract_view_exclusions_set_updated_at
  BEFORE UPDATE ON public.api_contract_view_exclusions
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

INSERT INTO public.api_contract_view_exclusions (schema_name, view_name, reason)
VALUES
  ('api', 'settings', 'Service-only config cache view (settings.cached_value).'),
  ('api', 'mapping_configs', 'Service-only config view (declarative transforms).'),
  ('api', 'operation_templates', 'Service-only config view (outbound call specs).')
ON CONFLICT (schema_name, view_name) DO UPDATE
SET
  reason = EXCLUDED.reason,
  updated_at = now();

-------------------------------------------------------------------------------
-- 2) Register + enforce table contract (timestamps + audit triggers)
-------------------------------------------------------------------------------

INSERT INTO public.table_contracts (
  table_schema,
  table_name,
  created_at_required,
  updated_at_required,
  audit_enabled,
  notes
)
VALUES (
  'public',
  'api_contract_view_exclusions',
  TRUE,
  TRUE,
  TRUE,
  'SSOT: api view exclusions for service-only contract views.'
)
ON CONFLICT (table_schema, table_name) DO UPDATE
SET
  created_at_required = EXCLUDED.created_at_required,
  updated_at_required = EXCLUDED.updated_at_required,
  audit_enabled = EXCLUDED.audit_enabled,
  notes = EXCLUDED.notes,
  updated_at = now();

SELECT * FROM public.apply_table_contracts('public');
SELECT * FROM public.ensure_audit_triggers();

-------------------------------------------------------------------------------
-- 3) Patch refresh_api_contract_views_v1 to skip service-only config views
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.refresh_api_contract_views_v1()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_public_ref TEXT;
  v_auth_select BOOLEAN;
  v_auth_insert BOOLEAN;
  v_auth_update BOOLEAN;
  v_auth_delete BOOLEAN;
  v_anon_select BOOLEAN;
  v_anon_insert BOOLEAN;
  v_anon_update BOOLEAN;
  v_anon_delete BOOLEAN;
  v_any_anon BOOLEAN := FALSE;
  v_has_exclusions BOOLEAN := FALSE;
BEGIN
  v_has_exclusions := (to_regclass('public.api_contract_view_exclusions') IS NOT NULL);

  EXECUTE 'CREATE SCHEMA IF NOT EXISTS api';
  EXECUTE 'REVOKE ALL ON SCHEMA api FROM PUBLIC';

  EXECUTE 'GRANT USAGE ON SCHEMA api TO authenticated';
  EXECUTE 'GRANT USAGE ON SCHEMA api TO service_role';

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO edge_label_renderer_role';
  END IF;

  FOR r IN
    SELECT tablename
    FROM public.security_rls_user_facing
    ORDER BY tablename
  LOOP
    IF v_has_exclusions AND EXISTS (
      SELECT 1
      FROM public.api_contract_view_exclusions x
      WHERE x.schema_name = 'api'
        AND x.view_name = r.tablename
    ) THEN
      CONTINUE;
    END IF;

    EXECUTE format(
      'CREATE OR REPLACE VIEW api.%I WITH (security_invoker = true) AS SELECT * FROM public.%I',
      r.tablename,
      r.tablename
    );

    EXECUTE format('REVOKE ALL ON api.%I FROM PUBLIC', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM anon', r.tablename);
    EXECUTE format('REVOKE ALL ON api.%I FROM authenticated', r.tablename);

    v_public_ref := format('public.%I', r.tablename);

    v_auth_select := has_table_privilege('authenticated', v_public_ref, 'select');
    v_auth_insert := has_table_privilege('authenticated', v_public_ref, 'insert');
    v_auth_update := has_table_privilege('authenticated', v_public_ref, 'update');
    v_auth_delete := has_table_privilege('authenticated', v_public_ref, 'delete');

    v_anon_select := has_table_privilege('anon', v_public_ref, 'select');
    v_anon_insert := has_table_privilege('anon', v_public_ref, 'insert');
    v_anon_update := has_table_privilege('anon', v_public_ref, 'update');
    v_anon_delete := has_table_privilege('anon', v_public_ref, 'delete');

    IF v_auth_select THEN EXECUTE format('GRANT SELECT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO authenticated', r.tablename); END IF;
    IF v_auth_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO authenticated', r.tablename); END IF;

    IF v_anon_select THEN EXECUTE format('GRANT SELECT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_insert THEN EXECUTE format('GRANT INSERT ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_update THEN EXECUTE format('GRANT UPDATE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;
    IF v_anon_delete THEN EXECUTE format('GRANT DELETE ON api.%I TO anon', r.tablename); v_any_anon := TRUE; END IF;

    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON api.%I TO service_role', r.tablename);
  END LOOP;

  IF v_any_anon THEN
    EXECUTE 'GRANT USAGE ON SCHEMA api TO anon';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM anon;
REVOKE ALL ON FUNCTION public.refresh_api_contract_views_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.refresh_api_contract_views_v1() TO service_role;

COMMENT ON FUNCTION public.refresh_api_contract_views_v1()
  IS 'Service-only: Rebuild api.<table> contract views for the current user-facing public surface, skipping api_contract_view_exclusions.';

-------------------------------------------------------------------------------
-- 4) Re-assert service-only config views + least-privilege grants
-------------------------------------------------------------------------------

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO service_role;

-- Settings (config cache)
CREATE OR REPLACE VIEW api.settings
WITH (security_invoker = true) AS
SELECT
  scope_type,
  scope_id,
  category,
  cached_value,
  last_updated
FROM public.settings;

REVOKE ALL ON api.settings FROM PUBLIC;
REVOKE ALL ON api.settings FROM anon;
REVOKE ALL ON api.settings FROM authenticated;
GRANT SELECT ON api.settings TO service_role;

-- Mapping configs (declarative transforms)
CREATE OR REPLACE VIEW api.mapping_configs
WITH (security_invoker = true) AS
SELECT * FROM public.mapping_configs;

REVOKE ALL ON api.mapping_configs FROM PUBLIC;
REVOKE ALL ON api.mapping_configs FROM anon;
REVOKE ALL ON api.mapping_configs FROM authenticated;
GRANT SELECT ON api.mapping_configs TO service_role;

-- Operation templates (outbound call specs)
CREATE OR REPLACE VIEW api.operation_templates
WITH (security_invoker = true) AS
SELECT
  id,
  provider_id,
  operation_name,
  method,
  url_template,
  headers_template,
  body_template,
  request_mappings,
  mapping_config_id,
  timeout_seconds
FROM public.operation_templates;

REVOKE ALL ON api.operation_templates FROM PUBLIC;
REVOKE ALL ON api.operation_templates FROM anon;
REVOKE ALL ON api.operation_templates FROM authenticated;
GRANT SELECT ON api.operation_templates TO service_role;

COMMIT;

