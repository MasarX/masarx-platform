-- Console V2 External Intake API request navigation.
--
-- Keep API/provider shipment intake discoverable from the same row-driven
-- External Intake operator area as webhook intake, while preserving the
-- protocol-specific api_gateway.read permission gate.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605141331_console_v2_external_intake_api_nav_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $navigation$
DECLARE
  v_scope RECORD;
  v_current JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_route_item JSONB := jsonb_build_object(
    'id', 'integrations-api-gateway',
    'key', 'int-api-gateway',
    'label', 'API request intake',
    'icon', 'gauge',
    'href', '/insights/api-gateway',
    'route', '/insights/api-gateway',
    'resource', 'api_gateway_observability',
    'capability', 'api_gateway.read',
    'capabilities', jsonb_build_array('api_gateway.read'),
    'capability_any', jsonb_build_array('api_gateway.read')
  );
  v_legacy_api_gateway_routes TEXT[] := ARRAY[
    '/console/resources/api_call_log',
    '/console/resources/api_route_packs',
    '/console/resources/api_routes'
  ];
  v_found_section BOOLEAN;
  v_found_item BOOLEAN;
BEGIN
  FOR v_scope IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_scope.value, '{}'::jsonb);
    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_new_sections := '[]'::jsonb;
    v_found_section := FALSE;

    FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value LOOP
      IF lower(COALESCE(v_section->>'id', '')) = 'integrations' THEN
        v_found_section := TRUE;
        v_items := COALESCE(v_section->'items', '[]'::jsonb);
        IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
          v_items := '[]'::jsonb;
        END IF;

        v_new_items := '[]'::jsonb;
        v_found_item := FALSE;

        FOR v_item IN SELECT value FROM jsonb_array_elements(v_items) AS value LOOP
          IF COALESCE(v_item->>'route', v_item->>'href') = ANY(v_legacy_api_gateway_routes) THEN
            CONTINUE;
          ELSIF COALESCE(v_item->>'route', v_item->>'href') = '/insights/api-gateway'
             OR COALESCE(v_item->>'id', '') IN ('insights-api-gateway', 'integrations-api-gateway')
             OR COALESCE(v_item->>'key', '') IN ('insights-api-gateway', 'int-api-gateway') THEN
            v_new_items := v_new_items || jsonb_build_array(v_item || v_route_item);
            v_found_item := TRUE;
          ELSE
            v_new_items := v_new_items || jsonb_build_array(v_item);
          END IF;
        END LOOP;

        IF NOT v_found_item THEN
          v_new_items := v_new_items || jsonb_build_array(v_route_item);
        END IF;

        v_section := jsonb_set(
          v_section || jsonb_build_object('id', 'integrations', 'label', 'External Intake'),
          '{items}',
          v_new_items,
          TRUE
        );
      ELSE
        v_items := COALESCE(v_section->'items', '[]'::jsonb);
        IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
          v_items := '[]'::jsonb;
        END IF;

        SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
         WHERE COALESCE(item.value->>'route', item.value->>'href') <> '/insights/api-gateway'
           AND COALESCE(item.value->>'route', item.value->>'href') <> ALL(v_legacy_api_gateway_routes)
           AND COALESCE(item.value->>'id', '') <> 'integrations-api-gateway'
           AND COALESCE(item.value->>'key', '') <> 'int-api-gateway';

        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      v_new_sections := v_new_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_found_section THEN
      v_new_sections := v_new_sections || jsonb_build_array(jsonb_build_object(
        'id', 'integrations',
        'label', 'External Intake',
        'items', jsonb_build_array(v_route_item)
      ));
    END IF;

    v_current := jsonb_set(v_current, '{apps,console,sections}', v_new_sections, TRUE);

    UPDATE public.settings_versions
       SET value = v_current,
           version = v_scope.version + 1,
           change_reason = 'Expose Console V2 API request intake through External Intake navigation',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_scope.settings_version_id
       AND value IS DISTINCT FROM v_current;

    UPDATE public.settings
       SET cached_value = v_current,
           last_updated = now()
     WHERE id = v_scope.settings_id
       AND cached_value IS DISTINCT FROM v_current;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605141331_console_v2_external_intake_api_nav_v1'));

COMMIT;
