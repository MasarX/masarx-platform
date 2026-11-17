-- Migration: UI navigation commands catalog
BEGIN;
SELECT pg_advisory_lock(hashtext('202601051000_ui_navigation_commands'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_console_base JSONB;
  v_console_sections JSONB := '[]'::jsonb;
  v_console_section JSONB;
  v_console_items JSONB;
  v_console_has_workflows BOOLEAN := FALSE;
  v_console_command JSONB := jsonb_build_object(
    'id', 'console-commands',
    'label', 'Commands',
    'href', '/console/commands'
  );
  v_portal_base JSONB;
  v_portal_sections JSONB := '[]'::jsonb;
  v_portal_section JSONB;
  v_portal_items JSONB;
  v_portal_has_requests BOOLEAN := FALSE;
  v_portal_command JSONB := jsonb_build_object(
    'id', 'portal-commands',
    'label', 'Commands',
    'href', '/portal/commands'
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

  v_console_base := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);

  FOR v_console_section IN SELECT * FROM jsonb_array_elements(v_console_base) LOOP
    IF v_console_section->>'id' = 'workflows' THEN
      v_console_has_workflows := TRUE;
      v_console_items := COALESCE(v_console_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_console_items) AS item
        WHERE item->>'id' = v_console_command->>'id'
      ) THEN
        v_console_items := v_console_items || jsonb_build_array(v_console_command);
      END IF;
      v_console_section := jsonb_set(v_console_section, '{items}', v_console_items, true);
    END IF;

    v_console_sections := v_console_sections || jsonb_build_array(v_console_section);
  END LOOP;

  IF v_console_has_workflows IS FALSE THEN
    v_console_sections := v_console_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'workflows',
        'label', 'Workflows',
        'items', jsonb_build_array(v_console_command)
      )
    );
  END IF;

  v_portal_base := COALESCE(v_current#>'{apps,portal,sections}', '[]'::jsonb);

  FOR v_portal_section IN SELECT * FROM jsonb_array_elements(v_portal_base) LOOP
    IF v_portal_section->>'id' = 'requests' THEN
      v_portal_has_requests := TRUE;
      v_portal_items := COALESCE(v_portal_section->'items', '[]'::jsonb);
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_portal_items) AS item
        WHERE item->>'id' = v_portal_command->>'id'
      ) THEN
        v_portal_items := v_portal_items || jsonb_build_array(v_portal_command);
      END IF;
      v_portal_section := jsonb_set(v_portal_section, '{items}', v_portal_items, true);
    END IF;

    v_portal_sections := v_portal_sections || jsonb_build_array(v_portal_section);
  END LOOP;

  IF v_portal_has_requests IS FALSE THEN
    v_portal_sections := v_portal_sections || jsonb_build_array(
      jsonb_build_object(
        'id', 'requests',
        'label', 'Requests',
        'items', jsonb_build_array(v_portal_command)
      )
    );
  END IF;

  v_current := jsonb_set(v_current, '{apps,console,sections}', v_console_sections, true);
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
        change_reason = 'Add commands navigation',
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

SELECT pg_advisory_unlock(hashtext('202601051000_ui_navigation_commands'));
COMMIT;
