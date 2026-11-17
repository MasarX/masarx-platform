-- Plan: B04 Sortation + zoning foundation
-- Issue: #2093 (UC061) with support for #2095 / #2094
-- Migration: B04 UI api contract v1
-- Purpose:
-- - Expose the zone/basket substrate through explicit api.* security_invoker views.
-- - Rebind the B04 ui_read_registry resources to api.* so browser/server UI reads
--   stay on the exposed api schema contract instead of direct public.* relations.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604021130_b04_ui_api_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE VIEW api.zones
WITH (security_invoker = true) AS
SELECT * FROM public.zones;

CREATE OR REPLACE VIEW api.zone_districts
WITH (security_invoker = true) AS
SELECT * FROM public.zone_districts;

CREATE OR REPLACE VIEW api.baskets
WITH (security_invoker = true) AS
SELECT * FROM public.baskets;

CREATE OR REPLACE VIEW api.basket_items
WITH (security_invoker = true) AS
SELECT * FROM public.basket_items;

CREATE OR REPLACE VIEW api.basket_transitions
WITH (security_invoker = true) AS
SELECT * FROM public.basket_transitions;

REVOKE ALL ON api.zones FROM PUBLIC;
REVOKE ALL ON api.zone_districts FROM PUBLIC;
REVOKE ALL ON api.baskets FROM PUBLIC;
REVOKE ALL ON api.basket_items FROM PUBLIC;
REVOKE ALL ON api.basket_transitions FROM PUBLIC;

REVOKE ALL ON api.zones FROM anon;
REVOKE ALL ON api.zone_districts FROM anon;
REVOKE ALL ON api.baskets FROM anon;
REVOKE ALL ON api.basket_items FROM anon;
REVOKE ALL ON api.basket_transitions FROM anon;

REVOKE ALL ON api.zones FROM authenticated;
REVOKE ALL ON api.zone_districts FROM authenticated;
REVOKE ALL ON api.baskets FROM authenticated;
REVOKE ALL ON api.basket_items FROM authenticated;
REVOKE ALL ON api.basket_transitions FROM authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON api.zones TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.zone_districts TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.baskets TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.basket_items TO authenticated;
GRANT SELECT ON api.basket_transitions TO authenticated;

GRANT SELECT, INSERT, UPDATE, DELETE ON api.zones TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.zone_districts TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.baskets TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.basket_items TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON api.basket_transitions TO service_role;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_key TEXT;
  v_relation TEXT;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
  IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_read_registry resources must be an array';
  END IF;

  FOR v_resource IN
    SELECT value
    FROM jsonb_array_elements(v_resources) AS value
  LOOP
    v_key := NULLIF(btrim(COALESCE(v_resource->>'key', '')), '');

    v_relation := CASE v_key
      WHEN 'zones' THEN 'api.zones'
      WHEN 'zone_districts' THEN 'api.zone_districts'
      WHEN 'baskets' THEN 'api.baskets'
      WHEN 'basket_items' THEN 'api.basket_items'
      WHEN 'basket_transitions' THEN 'api.basket_transitions'
      ELSE NULL
    END;

    IF v_relation IS NOT NULL THEN
      v_resource := jsonb_set(v_resource, '{relation}', to_jsonb(v_relation), TRUE);
    END IF;

    v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Rebind B04 zone and basket resources to api schema contract',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_current IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202604021130_b04_ui_api_contract_v1'));
COMMIT;
