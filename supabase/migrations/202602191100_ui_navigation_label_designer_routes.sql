-- Migration: Add label designer routes to console + portal navigation
BEGIN;
SELECT pg_advisory_lock(hashtext('202602191100_ui_navigation_label_designer_routes'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_portal_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_console_found BOOLEAN := FALSE;
  v_portal_found BOOLEAN := FALSE;
  v_console_item JSONB := jsonb_build_object(
    'id', 'console-label-designer',
    'label', 'Label designer',
    'href', '/console/labels/designer',
    'capability', 'label_design.read'
  );
  v_portal_item JSONB := jsonb_build_object(
    'id', 'portal-label-designer',
    'label', 'Label designer',
    'href', '/portal/labels/designer',
    'capability', 'label_design.read'
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

  FOR v_section IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'label-design' THEN
      v_console_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_items) AS item
         WHERE item->>'id' = 'console-label-designer'
      ) THEN
        v_items := v_items || jsonb_build_array(v_console_item);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_console_sections := v_console_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_console_found IS FALSE THEN
    v_console_sections := v_console_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'label-design',
        'label', 'Label design',
        'items', jsonb_build_array(v_console_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, TRUE);

  FOR v_section IN
    SELECT *
    FROM jsonb_array_elements(COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb))
  LOOP
    IF v_section->>'id' = 'shipments' THEN
      v_portal_found := TRUE;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_items) AS item
         WHERE item->>'id' = 'portal-label-designer'
      ) THEN
        v_items := v_items || jsonb_build_array(v_portal_item);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
    END IF;

    v_portal_sections := v_portal_sections || jsonb_build_array(v_section);
  END LOOP;

  IF v_portal_found IS FALSE THEN
    v_portal_sections := v_portal_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'shipments',
        'label', 'Shipments',
        'items', jsonb_build_array(v_portal_item)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_portal_sections, TRUE);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
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
           change_reason = 'Add label designer routes for console and portal',
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

SELECT pg_advisory_unlock(hashtext('202602191100_ui_navigation_label_designer_routes'));
COMMIT;
