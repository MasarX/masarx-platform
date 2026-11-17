-- Migration: Point workflow template navigation to workflow studio routes
BEGIN;
SELECT pg_advisory_lock(hashtext('202601192010_ui_navigation_workflow_studio_routes'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_portal_sections JSONB := '[]'::jsonb;
  v_section JSONB;
  v_items JSONB;
  v_out_items JSONB;
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

  -- Console: update workflow templates href to point to the studio list route.
  FOR v_section IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb))
  LOOP
    v_items := COALESCE(v_section->'items', '[]'::jsonb);
    v_out_items := '[]'::jsonb;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
      IF v_item->>'id' = 'workflow-templates' THEN
        v_item := jsonb_set(
          v_item,
          '{href}',
          to_jsonb('/console/workflows/templates'::text),
          true
        );
      END IF;
      v_out_items := v_out_items || jsonb_build_array(v_item);
    END LOOP;
    v_section := jsonb_set(v_section, '{items}', v_out_items, true);
    v_console_sections := v_console_sections || jsonb_build_array(v_section);
  END LOOP;
  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, true);

  -- Portal: update workflow templates href to point to the studio list route.
  FOR v_section IN
    SELECT * FROM jsonb_array_elements(COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb))
  LOOP
    v_items := COALESCE(v_section->'items', '[]'::jsonb);
    v_out_items := '[]'::jsonb;
    FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
      IF v_item->>'id' IN ('portal-workflow-templates', 'workflow-templates') THEN
        v_item := jsonb_set(
          v_item,
          '{href}',
          to_jsonb('/portal/workflows/templates'::text),
          true
        );
      END IF;
      v_out_items := v_out_items || jsonb_build_array(v_item);
    END LOOP;
    v_section := jsonb_set(v_section, '{items}', v_out_items, true);
    v_portal_sections := v_portal_sections || jsonb_build_array(v_section);
  END LOOP;
  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_portal_sections, true);

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
           change_reason = 'Point workflow templates to studio routes',
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

SELECT pg_advisory_unlock(hashtext('202601192010_ui_navigation_workflow_studio_routes'));
COMMIT;

