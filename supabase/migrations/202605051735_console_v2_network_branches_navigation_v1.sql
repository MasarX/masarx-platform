-- Migration: Console V2 live navigation for network branches
-- Purpose:
--   Keep the live ui_navigation settings aligned with the Console V2
--   operations lifecycle. Branches are a first-class network surface and must
--   be reachable from the operator shell, not only through seed navigation or
--   direct URLs.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051735_console_v2_network_branches_navigation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_clean_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_section_id TEXT;
  v_has_network BOOLEAN;
  v_inserted BOOLEAN;
  v_branch_item JSONB := jsonb_build_object(
    'id', 'network-branches',
    'key', 'network-branches',
    'label', 'Branches',
    'href', '/network/branches',
    'route', '/network/branches',
    'resource', 'branches',
    'capability', 'branches.read',
    'icon', 'building'
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
    v_has_network := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := COALESCE(v_section->>'id', '');
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      IF v_section_id = 'network' THEN
        v_has_network := TRUE;

        SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
          INTO v_clean_items
          FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
         WHERE COALESCE(item.value->>'route', item.value->>'href', '') <> '/network/branches'
           AND COALESCE(item.value->>'key', item.value->>'id', '') NOT IN ('network-branches', 'branches');

        v_new_items := '[]'::jsonb;
        v_inserted := FALSE;

        FOR v_item IN
          SELECT value
          FROM jsonb_array_elements(v_clean_items) AS value
        LOOP
          IF NOT v_inserted
             AND (
               COALESCE(v_item->>'route', v_item->>'href', '') IN ('/network/zones', '/network/marketplace')
               OR COALESCE(v_item->>'key', v_item->>'id', '') IN ('network-zones', 'zones', 'network-marketplace', 'marketplace')
             ) THEN
            v_new_items := v_new_items || jsonb_build_array(v_branch_item);
            v_inserted := TRUE;
          END IF;

          v_new_items := v_new_items || jsonb_build_array(v_item);
        END LOOP;

        IF NOT v_inserted THEN
          v_new_items := v_new_items || jsonb_build_array(v_branch_item);
        END IF;

        v_section := jsonb_set(v_section, '{items}', v_new_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_network THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'network',
          'label', 'Network',
          'items', jsonb_build_array(v_branch_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 Branches in live network navigation',
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

SELECT pg_advisory_unlock(hashtext('202605051735_console_v2_network_branches_navigation_v1'));

COMMIT;
