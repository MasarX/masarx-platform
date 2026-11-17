-- Plan: PLAN-202602-mobile-field-ops-native-app-v1 / Step: S04
-- Migration: ui_navigation apps.mobile defaults v1
-- Purpose:
-- - Seed minimal mobile navigation for Field Ops (SSOT-driven; no hardcoded roles).
-- - Keep navigation row-driven via ui_navigation settings (scope ladder) + capability gating.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041611_ui_navigation_mobile_v1'));
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
  v_has_tasks_section BOOLEAN := FALSE;
  v_tasks_item JSONB := jsonb_build_object(
    'id', 'mobile-tasks',
    'label', 'Tasks',
    'resource', 'tasks',
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
    IF v_section->>'id' = 'tasks' THEN
      v_has_tasks_section := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = v_tasks_item->>'id'
      ) THEN
        v_items := v_items || jsonb_build_array(v_tasks_item);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;

    v_new_sections := v_new_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_tasks_section IS FALSE THEN
    v_new_sections := v_new_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'tasks',
        'label', 'Tasks',
        'items', jsonb_build_array(v_tasks_item)
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
        change_reason = 'Add ui_navigation apps.mobile defaults (tasks)',
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

SELECT pg_advisory_unlock(hashtext('202602041611_ui_navigation_mobile_v1'));
COMMIT;
