-- Migration: Expose workflow templates in navigation (console + portal)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191420_ui_navigation_workflow_templates'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_sections JSONB;
  v_updated JSONB;
  v_section JSONB;
  v_items JSONB;
  v_candidate JSONB;
  v_has_workflows BOOLEAN := false;
  v_portal_out JSONB := '[]'::jsonb;
  v_console_out JSONB := '[]'::jsonb;
  v_console_item JSONB := jsonb_build_object(
    'id', 'workflow-templates',
    'label', 'Workflow templates',
    'href', '/console/resources/workflow_templates',
    'resource', 'workflow_templates',
    'capability', 'workflow_runs.read'
  );
  v_portal_section JSONB := jsonb_build_object(
    'id', 'workflows',
    'label', 'Workflows',
    'items', jsonb_build_array(
      jsonb_build_object(
        'id', 'portal-workflow-templates',
        'label', 'Workflow templates',
        'href', '/portal/resources/workflow_templates',
        'resource', 'workflow_templates',
        'capability', 'workflow_runs.read'
      ),
      jsonb_build_object(
        'id', 'portal-workflow-runs',
        'label', 'Workflow runs',
        'href', '/portal/resources/workflow_runs',
        'resource', 'workflow_runs',
        'capability', 'workflow_runs.read'
      )
    )
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

  -- Console: add workflow templates item under workflows section.
  v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
  v_console_out := '[]'::jsonb;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    IF v_section->>'id' = 'workflows' THEN
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      v_candidate := v_console_item;
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_items) AS item
        WHERE item->>'id' = v_candidate->>'id'
      ) THEN
        v_items := v_items || jsonb_build_array(v_candidate);
      END IF;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_console_out := v_console_out || jsonb_build_array(v_section);
  END LOOP;
  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_out, true);

  -- Portal: ensure workflows section exists (append if missing).
  v_sections := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);
  v_portal_out := '[]'::jsonb;
  v_has_workflows := false;
  FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
    IF v_section->>'id' = 'workflows' THEN
      v_has_workflows := true;
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_portal_section->'items') LOOP
        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_items) AS item
          WHERE item->>'id' = v_candidate->>'id'
        ) THEN
          v_items := v_items || jsonb_build_array(v_candidate);
        END IF;
      END LOOP;
      v_section := jsonb_set(v_section, '{items}', v_items, true);
    END IF;
    v_portal_out := v_portal_out || jsonb_build_array(v_section);
  END LOOP;

  IF v_has_workflows IS DISTINCT FROM true THEN
    v_portal_out := v_portal_out || jsonb_build_array(v_portal_section);
  END IF;

  v_current := jsonb_set(v_current, '{apps,portal,sections}', v_portal_out, true);

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
           change_reason = 'Expose workflow templates navigation',
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

SELECT pg_advisory_unlock(hashtext('202601191420_ui_navigation_workflow_templates'));
COMMIT;
