-- Migration: Console V2 operator-safe navigation labels
-- Purpose:
--   Keep row-driven Console V2 navigation labels aligned with operator domain
--   language. The live ui_navigation settings are the source of truth for the
--   sidebar and command palette, so label cleanup must update every scoped
--   settings row, not only the bundled frontend seed.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051610_console_v2_operator_navigation_labels_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_sections JSONB := '[]'::jsonb;
  v_updated_sections JSONB := '[]'::jsonb;
  v_section JSONB := NULL;
  v_items JSONB := '[]'::jsonb;
  v_section_id TEXT := NULL;
  v_has_lookup BOOLEAN := FALSE;
  v_has_access BOOLEAN := FALSE;
  v_has_readiness BOOLEAN := FALSE;
  v_has_platform_section BOOLEAN := FALSE;
  v_lookup_item JSONB := jsonb_build_object(
    'id', 'catalog-lookups',
    'key', 'lookups',
    'label', 'Reference data',
    'href', '/catalog/lookups',
    'route', '/catalog/lookups',
    'resource', 'lookup_definitions',
    'capability', 'lookups.read',
    'icon', 'list'
  );
  v_access_item JSONB := jsonb_build_object(
    'id', 'platform-access',
    'key', 'access',
    'label', 'Access control',
    'href', '/platform/access',
    'route', '/platform/access',
    'resource', 'access_control_policy',
    'capability', 'access_policy.read',
    'icon', 'shield'
  );
  v_readiness_item JSONB := jsonb_build_object(
    'id', 'platform-onboarding-readiness',
    'key', 'onboarding-readiness',
    'label', 'Onboarding readiness',
    'href', '/platform/onboarding-readiness',
    'route', '/platform/onboarding-readiness',
    'resource', 'onboarding_readiness',
    'capability', 'settings.read',
    'icon', 'check'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_platform_section := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := COALESCE(v_section->>'id', '');
      IF v_section_id = 'platform' THEN
        v_has_platform_section := TRUE;
      END IF;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(
               jsonb_agg(
                 CASE
                   WHEN COALESCE(item.value->>'route', item.value->>'href', '') = '/catalog/lookups'
                     OR COALESCE(item.value->>'key', item.value->>'id', '') IN ('lookups', 'catalog-lookups')
                     THEN item.value || jsonb_build_object('label', 'Reference data')
                   WHEN COALESCE(item.value->>'route', item.value->>'href', '') = '/platform/access'
                     OR COALESCE(item.value->>'key', item.value->>'id', '') IN ('access', 'platform-access')
                     THEN item.value || jsonb_build_object('label', 'Access control')
                   ELSE item.value
                 END
                 ORDER BY item.ordinality
               ),
               '[]'::jsonb
             )
        INTO v_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
               '/console/resources/lookup_definitions',
               '/console/resources/lookup_values'
             )
         AND COALESCE(item.value->>'resource', '') NOT IN (
               'lookup_definitions',
               'lookup_values'
             );

      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/catalog/lookups'
           OR COALESCE(item.value->>'key', item.value->>'id', '') IN ('lookups', 'catalog-lookups')
      )
        INTO v_has_lookup;

      IF v_section_id IN ('catalog', 'reference-data') AND NOT v_has_lookup THEN
        v_items := v_items || jsonb_build_array(v_lookup_item);
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/platform/access'
           OR COALESCE(item.value->>'key', item.value->>'id', '') IN ('access', 'platform-access')
      )
        INTO v_has_access;

      IF v_section_id = 'platform' AND NOT v_has_access THEN
        v_items := v_items || jsonb_build_array(v_access_item);
      END IF;

      SELECT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item(value)
        WHERE COALESCE(item.value->>'route', item.value->>'href', '') = '/platform/onboarding-readiness'
           OR COALESCE(item.value->>'key', item.value->>'id', '') IN (
                'onboarding-readiness',
                'platform-onboarding-readiness'
              )
      )
        INTO v_has_readiness;

      IF v_section_id = 'platform' AND NOT v_has_readiness THEN
        v_items := v_items || jsonb_build_array(v_readiness_item);
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_platform_section AND jsonb_array_length(v_updated_sections) > 0 THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'platform',
          'label', 'Platform',
          'items', jsonb_build_array(v_access_item, v_readiness_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Align Console V2 navigation labels to operator-safe domain wording',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605051610_console_v2_operator_navigation_labels_v1'));

COMMIT;
