-- Console V2 Workflows Bindings navigation discoverability.
-- Keeps the row-driven live Console navigation exposing the canonical
-- Bindings & triggers workbench instead of relying on a hidden route.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605231120_console_v2_workflow_bindings_navigation_discoverability_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_clean_items JSONB;
  v_section_id TEXT;
  v_has_workflows BOOLEAN;
  v_has_bindings BOOLEAN;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
  v_bindings_item JSONB := jsonb_build_object(
    'id', 'wf-bindings',
    'key', 'wf-bindings',
    'label', 'Bindings & triggers',
    'href', '/workflows/bindings',
    'route', '/workflows/bindings',
    'resource', 'workflow_binding_directory',
    'capability', 'workflows.read',
    'icon', 'git'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.schema_version,
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
    v_has_workflows := FALSE;

    FOR v_section IN
      SELECT value
      FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := lower(COALESCE(v_section->>'id', v_section->>'label', ''));
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(
               jsonb_agg(
                 CASE
                   WHEN COALESCE(item.value->>'route', item.value->>'href', item.value->>'path', '') = '/workflows/bindings'
                     OR COALESCE(item.value->>'key', item.value->>'id', '') = 'wf-bindings'
                     THEN item.value || v_bindings_item
                   ELSE item.value
                 END
                 ORDER BY item.ordinality
               ),
               '[]'::jsonb
             )
        INTO v_clean_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality);

      IF v_section_id = 'workflows' THEN
        v_has_workflows := TRUE;

        SELECT EXISTS (
          SELECT 1
          FROM jsonb_array_elements(v_clean_items) AS item(value)
          WHERE COALESCE(item.value->>'route', item.value->>'href', item.value->>'path', '') = '/workflows/bindings'
        )
          INTO v_has_bindings;

        IF NOT v_has_bindings THEN
          v_clean_items := v_clean_items || jsonb_build_array(v_bindings_item);
        END IF;

        v_section := jsonb_set(
          v_section || jsonb_build_object('id', 'workflows', 'label', 'Workflows'),
          '{items}',
          v_clean_items,
          TRUE
        );
      ELSE
        v_section := jsonb_set(v_section, '{items}', v_clean_items, TRUE);
      END IF;

      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_workflows THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(
        jsonb_build_object(
          'id', 'workflows',
          'label', 'Workflows',
          'items', jsonb_build_array(v_bindings_item)
        )
      );
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET effective_until = CASE
               WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
               ELSE now()
             END,
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      SELECT COALESCE(MAX(version), 0) + 1
        INTO v_next_version
        FROM public.settings_versions
       WHERE category = 'ui_navigation'
         AND scope_type = v_row.scope_type
         AND scope_id IS NOT DISTINCT FROM v_row.scope_id;

      INSERT INTO public.settings_versions (
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from
      ) VALUES (
        'ui_navigation',
        v_row.scope_type,
        v_row.scope_id,
        v_next_version,
        v_next,
        COALESCE(v_row.schema_version, 1),
        'Expose Workflows Bindings & triggers in Console V2 navigation',
        now(),
        now()
      )
      RETURNING id INTO v_new_settings_version_id;

      UPDATE public.settings
         SET settings_version_id = v_new_settings_version_id,
             cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605231120_console_v2_workflow_bindings_navigation_discoverability_v1'));

COMMIT;
