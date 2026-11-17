-- Plan: B04 UC061 Portal/Console discoverability closeout
-- Issue: #2093
-- Purpose:
-- - Backfill B04 zone and basket navigation items across all scoped ui_navigation rows.
-- - Keep Console and Portal discoverability aligned with the existing B04 ui_read_registry/api contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604041600_b04_uc061_ui_navigation_discoverability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_source_sections JSONB := '[]'::jsonb;
  v_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
  v_has_operations BOOLEAN := FALSE;
  v_console_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'console-zones',
      'label', 'Zones',
      'href', '/console/resources/zones',
      'resource', 'zones',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'console-zone-districts',
      'label', 'Zone districts',
      'href', '/console/resources/zone_districts',
      'resource', 'zone_districts',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'console-baskets',
      'label', 'Baskets',
      'href', '/console/resources/baskets',
      'resource', 'baskets',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'console-basket-items',
      'label', 'Basket items',
      'href', '/console/resources/basket_items',
      'resource', 'basket_items',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'console-basket-transitions',
      'label', 'Basket transitions',
      'href', '/console/resources/basket_transitions',
      'resource', 'basket_transitions',
      'capability', 'baskets.read'
    )
  );
  v_portal_items JSONB := jsonb_build_array(
    jsonb_build_object(
      'id', 'portal-zones',
      'label', 'Zones',
      'href', '/portal/resources/zones',
      'resource', 'zones',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'portal-zone-districts',
      'label', 'Zone districts',
      'href', '/portal/resources/zone_districts',
      'resource', 'zone_districts',
      'capability', 'zones.read'
    ),
    jsonb_build_object(
      'id', 'portal-baskets',
      'label', 'Baskets',
      'href', '/portal/resources/baskets',
      'resource', 'baskets',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'portal-basket-items',
      'label', 'Basket items',
      'href', '/portal/resources/basket_items',
      'resource', 'basket_items',
      'capability', 'baskets.read'
    ),
    jsonb_build_object(
      'id', 'portal-basket-transitions',
      'label', 'Basket transitions',
      'href', '/portal/resources/basket_transitions',
      'resource', 'basket_transitions',
      'capability', 'baskets.read'
    )
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_source_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE COALESCE(item->>'id', '') NOT IN (
           'console-zones',
           'console-zone-districts',
           'console-baskets',
           'console-basket-items',
           'console-basket-transitions'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_console_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_console_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_sections, TRUE);

    v_source_sections := COALESCE(v_next#>'{apps,portal,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_source_sections) IS DISTINCT FROM 'array' THEN
      v_source_sections := '[]'::jsonb;
    END IF;

    v_sections := '[]'::jsonb;
    v_has_operations := FALSE;
    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_source_sections) AS value
    LOOP
      IF v_section ? 'items' THEN
        SELECT COALESCE(jsonb_agg(item), '[]'::jsonb)
          INTO v_items
          FROM jsonb_array_elements(COALESCE(v_section->'items', '[]'::jsonb)) AS item
         WHERE COALESCE(item->>'id', '') NOT IN (
           'portal-zones',
           'portal-zone-districts',
           'portal-baskets',
           'portal-basket-items',
           'portal-basket-transitions'
         );
        v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      END IF;

      IF v_section->>'id' = 'operations' THEN
        v_has_operations := TRUE;
        v_section := jsonb_set(
          v_section,
          '{items}',
          COALESCE(v_section->'items', '[]'::jsonb) || v_portal_items,
          TRUE
        );
      END IF;

      v_sections := v_sections || jsonb_build_array(v_section);
    END LOOP;

    IF v_has_operations IS FALSE THEN
      IF jsonb_array_length(v_sections) > 0 AND (v_sections->0->>'id') = 'home' THEN
        v_sections := jsonb_build_array(
          v_sections->0,
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || (v_sections - 0);
      ELSE
        v_sections := jsonb_build_array(
          jsonb_build_object('id', 'operations', 'label', 'Operations', 'items', v_portal_items)
        ) || v_sections;
      END IF;
    END IF;

    v_next := jsonb_set(v_next, '{apps,portal,sections}', v_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Backfill B04 zone and basket discoverability across scoped ui_navigation rows.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604041600_b04_uc061_ui_navigation_discoverability_v1'));
COMMIT;
