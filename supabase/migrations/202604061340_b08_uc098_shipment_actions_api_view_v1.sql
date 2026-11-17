-- Migration: B08 UC098 shipment_actions api view refresh v1
-- Purpose:
-- - Refresh the browser-safe api.shipment_actions projection after adding
--   partial-delivery generated columns on public.shipment_actions.
-- - Rebind the shipment_actions ui_read_registry resource to api.shipment_actions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604061340_b08_uc098_shipment_actions_api_view_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
REVOKE USAGE ON SCHEMA api FROM anon;
GRANT USAGE ON SCHEMA api TO authenticated;
GRANT USAGE ON SCHEMA api TO service_role;

CREATE OR REPLACE VIEW api.shipment_actions
WITH (security_invoker = true) AS
SELECT *
FROM public.shipment_actions;

REVOKE ALL ON api.shipment_actions FROM PUBLIC;
REVOKE ALL ON api.shipment_actions FROM anon;
GRANT SELECT ON api.shipment_actions TO authenticated, service_role;

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
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
    IF v_resource->>'key' = 'shipment_actions' THEN
      v_resource := jsonb_set(v_resource, '{relation}', to_jsonb('api.shipment_actions'::text), TRUE);
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
           change_reason = 'Rebind shipment_actions ui reads to api.shipment_actions',
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

SELECT pg_advisory_unlock(hashtext('202604061340_b08_uc098_shipment_actions_api_view_v1'));
COMMIT;
