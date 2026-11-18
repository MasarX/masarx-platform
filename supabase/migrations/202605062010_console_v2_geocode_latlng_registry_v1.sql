-- Migration: Console V2 geocode map projection
-- Purpose:
--   Console V2 map surfaces read geocodes through ui_read_registry. The
--   canonical public.geocodes table stores coordinates as a PostGIS geography
--   point, while map components need scalar lat/lng values. This projection
--   keeps public.geocodes as the SSOT and exposes read-only scalar map fields
--   through an api-schema security_invoker view that the shared UI read
--   helpers allow and browser clients can resolve through the exposed schema.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605062010_console_v2_geocode_latlng_registry_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DROP VIEW IF EXISTS public.v_geocodes_with_latlng_v1;
DROP VIEW IF EXISTS api.geocodes;

CREATE OR REPLACE VIEW api.geocodes
WITH (security_invoker = true) AS
SELECT
  g.id,
  g.organization_id,
  g.client_id,
  g.address_id,
  g.provider_name,
  CASE
    WHEN g.coordinates IS NULL THEN NULL
    ELSE ST_Y(g.coordinates::geometry)::DOUBLE PRECISION
  END AS latitude,
  CASE
    WHEN g.coordinates IS NULL THEN NULL
    ELSE ST_X(g.coordinates::geometry)::DOUBLE PRECISION
  END AS longitude,
  CASE
    WHEN g.coordinates IS NULL THEN NULL
    ELSE ST_Y(g.coordinates::geometry)::DOUBLE PRECISION
  END AS lat,
  CASE
    WHEN g.coordinates IS NULL THEN NULL
    ELSE ST_X(g.coordinates::geometry)::DOUBLE PRECISION
  END AS lng,
  g.confidence_score,
  g.accuracy_type,
  g.formatted_address,
  g.metadata,
  g.is_primary,
  g.geocoded_at,
  g.expires_at,
  g.created_at,
  g.updated_at,
  (
    CASE
      WHEN g.expires_at IS NULL OR g.expires_at > now() THEN 1000000000000000::NUMERIC
      ELSE 0::NUMERIC
    END
    + CASE WHEN g.is_primary IS TRUE THEN 1000000000000::NUMERIC ELSE 0::NUMERIC END
    + COALESCE(g.confidence_score, 0)::NUMERIC * 1000000000::NUMERIC
    + COALESCE(EXTRACT(EPOCH FROM g.geocoded_at), 0)::NUMERIC
  ) AS map_rank
FROM public.geocodes g;

REVOKE ALL ON api.geocodes FROM PUBLIC;
REVOKE ALL ON api.geocodes FROM anon;
GRANT SELECT ON api.geocodes TO authenticated, service_role;

COMMENT ON VIEW api.geocodes IS
  'Console V2 read projection over public.geocodes with map-ready latitude/longitude and lat/lng aliases derived from canonical PostGIS coordinates. SECURITY INVOKER keeps caller RLS in force.';

DO $do$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           COALESCE(s.cached_value, '{"resources":[]}'::jsonb) AS cached_value
      FROM public.settings s
     WHERE s.category = 'ui_read_registry'
       AND jsonb_path_exists(
             COALESCE(s.cached_value, '{"resources":[]}'::jsonb),
             '$.resources[*] ? (@.key == "geocodes")'
           )
  LOOP
    v_current := v_setting.cached_value;

    SELECT COALESCE(
             jsonb_agg(
               CASE
                 WHEN resource.value->>'key' = 'geocodes' THEN
                   jsonb_set(
                     jsonb_set(
                       resource.value,
                       '{relation}',
                       to_jsonb('api.geocodes'::TEXT),
                       TRUE
                     ),
                     '{default_sort}',
                     jsonb_build_object('column', 'map_rank', 'direction', 'desc'),
                     TRUE
                   )
                   ||
                   jsonb_build_object(
                     'scope_columns',
                     jsonb_build_object(
                       'tenant', 'organization_id',
                       'client', 'client_id'
                     )
                   )
                 ELSE resource.value
               END
               ORDER BY resource.ordinality
             ),
             '[]'::jsonb
           )
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb))
           WITH ORDINALITY AS resource(value, ordinality);

    v_current := jsonb_set(v_current, '{resources}', v_resources, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           updated_at = now(),
           change_reason = 'Expose Console V2 geocodes through map-ready security-invoker projection'
     WHERE id = v_setting.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_setting.setting_id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605062010_console_v2_geocode_latlng_registry_v1'));

COMMIT;
