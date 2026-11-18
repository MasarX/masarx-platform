-- Migration: Console V2 open geocoding policy default
-- Purpose:
--   First-tenant Console V2 shipment intake must not fail because a tenant has
--   no proprietary geocoding provider configured. The production-safe default is
--   canonical local geocoding from PostGIS/OSM-derived reference data, then
--   manual review for unresolved addresses. External providers remain an
--   explicit tenant policy/credential choice, not a default hidden dependency.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090230_console_v2_open_geocoding_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.console_v2_open_geocoding_policy_v1(
  p_policy JSONB
)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_set(
    jsonb_set(
      jsonb_set(
        jsonb_set(
          COALESCE(p_policy, '{}'::jsonb),
          '{provider_priority}',
          '[]'::jsonb,
          TRUE
        ),
        '{local_lookup}',
        COALESCE(p_policy->'local_lookup', '{}'::jsonb)
          || jsonb_build_object(
            'enabled', TRUE,
            'min_confidence', 0.6,
            'allow_provider_fallback', FALSE,
            'prefer_district_centroid', TRUE
          ),
        TRUE
      ),
      '{provider_agreement_rules}',
      COALESCE(p_policy->'provider_agreement_rules', '{}'::jsonb)
        || jsonb_build_object('if_disagree', 'manual_review'),
      TRUE
    ),
    '{metadata}',
    COALESCE(p_policy->'metadata', '{}'::jsonb)
      || jsonb_build_object(
        'provider_strategy', 'postgis_canonical_local_then_manual_review',
        'external_provider_default', 'disabled_until_explicitly_configured',
        'open_geocoding_stack', jsonb_build_object(
          'map_engine', 'maplibre',
          'map_data', 'openstreetmap',
          'geospatial_source_of_truth', 'postgis',
          'routing_engine', 'valhalla',
          'optimization_engine', 'vroom'
        )
      ),
    TRUE
  );
$function$;

WITH patched AS (
  UPDATE public.settings_versions sv
     SET value = public.console_v2_open_geocoding_policy_v1(sv.value),
         change_reason = COALESCE(NULLIF(sv.change_reason, ''), 'geocoding_policy')
           || '; Console V2 open geocoding default: PostGIS/local then manual review'
   WHERE sv.category = 'geocoding_policy'
     AND (
       COALESCE(sv.value->'provider_priority', '[]'::jsonb) <> '[]'::jsonb
       OR COALESCE(sv.value #>> '{local_lookup,allow_provider_fallback}', '') IS DISTINCT FROM 'false'
       OR COALESCE((sv.value #>> '{local_lookup,min_confidence}')::numeric, 1) > 0.6
       OR COALESCE(sv.value #>> '{metadata,external_provider_default}', '') IS DISTINCT FROM 'disabled_until_explicitly_configured'
     )
   RETURNING sv.id, sv.value
)
UPDATE public.settings s
   SET cached_value = p.value,
       last_updated = now()
  FROM patched p
 WHERE s.settings_version_id = p.id
   AND s.category = 'geocoding_policy';

UPDATE public.settings s
   SET cached_value = public.console_v2_open_geocoding_policy_v1(s.cached_value),
       last_updated = now()
 WHERE s.category = 'geocoding_policy'
   AND (
     COALESCE(s.cached_value->'provider_priority', '[]'::jsonb) <> '[]'::jsonb
     OR COALESCE(s.cached_value #>> '{local_lookup,allow_provider_fallback}', '') IS DISTINCT FROM 'false'
     OR COALESCE((s.cached_value #>> '{local_lookup,min_confidence}')::numeric, 1) > 0.6
     OR COALESCE(s.cached_value #>> '{metadata,external_provider_default}', '') IS DISTINCT FROM 'disabled_until_explicitly_configured'
   );

REVOKE ALL ON FUNCTION public.console_v2_open_geocoding_policy_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.console_v2_open_geocoding_policy_v1(JSONB) TO service_role;

COMMENT ON FUNCTION public.console_v2_open_geocoding_policy_v1(JSONB) IS
  'Normalizes geocoding_policy to the Console V2 first-tenant default: local PostGIS/OSM-derived canonical lookup, then manual review; no proprietary provider fallback unless explicitly configured later.';

SELECT pg_advisory_unlock(hashtext('202605090230_console_v2_open_geocoding_policy_v1'));
COMMIT;
