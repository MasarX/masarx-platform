-- Plan: PLAN-202602-fieldops-mobile-app-prod-completion / Step: S03
-- Migration: Extend ui_navigation apps.mobile with More route
-- Date: 2026-02-06
--
-- Purpose:
-- - Keep mobile shell controls reachable through row-driven ui_navigation.
-- - Append /mobile/more when missing (idempotent).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602061550_ui_navigation_mobile_more_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_apps JSONB := '{}'::jsonb;
  v_mobile JSONB;
  v_sections JSONB := '[]'::jsonb;
  v_new_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_has_tools_section BOOLEAN := FALSE;
  v_more_item JSONB := jsonb_build_object(
    'id', 'mobile-more',
    'label', 'More',
    'href', '/mobile/more',
    'capability', 'tasks.read'
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_navigation global settings missing';
  END IF;

  v_apps := COALESCE(v_current->'apps', '{}'::jsonb);
  v_mobile := COALESCE(v_apps->'mobile', jsonb_build_object('sections', '[]'::jsonb));
  v_sections := COALESCE(v_mobile->'sections', '[]'::jsonb);

  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    IF v_section->>'id' = 'tools' THEN
      v_has_tools_section := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = 'mobile-more'
      ) THEN
        v_items := v_items || jsonb_build_array(v_more_item);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;

    v_new_sections := v_new_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_tools_section IS FALSE THEN
    v_new_sections := v_new_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'tools',
        'label', 'Tools',
        'items', jsonb_build_array(v_more_item)
      )
    );
  END IF;

  v_mobile := jsonb_set(v_mobile, '{sections}', v_new_sections, true);
  v_apps := jsonb_set(v_apps, '{mobile}', v_mobile, true);
  v_current := jsonb_set(v_current, '{apps}', v_apps, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_navigation'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Extend ui_navigation apps.mobile with /mobile/more route',
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
   WHERE s.category = 'ui_navigation'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202602061550_ui_navigation_mobile_more_v1'));
COMMIT;
