-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Add service-only `api.*` contract views for config validation and ops tooling.
-- Rationale:
--   - Only `api` schema is exposed via PostgREST; internal SSOT tables remain in `public`.
--   - Some ops tooling (e.g. validate:configs) uses REST fallback when DB connectivity is degraded.
--   - Provide minimal, least-privilege service-role-only views for required config reads without
--     exposing internal base tables to anon/authenticated.

BEGIN;

SET search_path TO public, extensions, pg_temp;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO service_role;

-------------------------------------------------------------------------------
-- Settings (config cache)
-------------------------------------------------------------------------------

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

-------------------------------------------------------------------------------
-- Mapping configs (declarative transforms)
-------------------------------------------------------------------------------

CREATE OR REPLACE VIEW api.mapping_configs
WITH (security_invoker = true) AS
SELECT
  id,
  mapping_type,
  mapping_key,
  mapping_config
FROM public.mapping_configs;

REVOKE ALL ON api.mapping_configs FROM PUBLIC;
REVOKE ALL ON api.mapping_configs FROM anon;
REVOKE ALL ON api.mapping_configs FROM authenticated;
GRANT SELECT ON api.mapping_configs TO service_role;

-------------------------------------------------------------------------------
-- Operation templates (outbound call specs)
-------------------------------------------------------------------------------

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

