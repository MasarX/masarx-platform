-- Plan: PLAN-202602-fieldops-driver-go-live / Step: S04
-- Migration: Align FieldOps mobile tools capabilities (scan/location) to ingest-specific caps.
-- Purpose:
--   - Keep module gating policy-driven via ui_navigation + access_control_policy.
--   - Use fine-grained capabilities:
--     - scan -> scan_events.write
--     - location -> location_pings.write
--   - Idempotent update of global ui_navigation apps.mobile sections.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602141045_ui_navigation_mobile_tools_ingest_caps_v2'));
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
  v_new_items JSONB;
  v_item JSONB;
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
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      v_new_items := '[]'::jsonb;

      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
        IF v_item->>'id' = 'mobile-scan' THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('scan_events.write'::text), true);
        ELSIF v_item->>'id' = 'mobile-location' THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('location_pings.write'::text), true);
        END IF;
        v_new_items := v_new_items || jsonb_build_array(v_item);
      END LOOP;

      v_section := jsonb_set(v_section, '{items}', v_new_items, true);
    END IF;

    v_new_sections := v_new_sections || jsonb_build_array(v_section);
  END LOOP;

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
           change_reason = 'Align FieldOps mobile tools capabilities to scan/location ingest caps',
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

SELECT pg_advisory_unlock(hashtext('202602141045_ui_navigation_mobile_tools_ingest_caps_v2'));
COMMIT;

