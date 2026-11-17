-- Plan: PLAN-202601-schema-prod-finalization / Step: S04
-- Migration: Restore service-only `api.*` contract views for ops tooling (fixup)
-- Why:
--   - `api` is the only PostgREST-exposed schema; some views are intentionally service-role-only
--     to support ops tooling and degraded-connectivity validation without granting tenant access.
--   - A prior dynamic contract-view regeneration may have widened grants on these views.
-- What:
--   - Recreate the service-only config views and re-assert least-privilege grants:
--     service_role SELECT only; deny anon/authenticated.

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
SELECT * FROM public.mapping_configs;

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
