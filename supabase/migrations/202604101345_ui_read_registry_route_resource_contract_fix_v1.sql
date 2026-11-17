-- Purpose: keep route registry resources aligned with the ui_read_registry schema
-- contract. `default_sort` remains a single object and every resource needs an
-- explicit `id_column`.

BEGIN;

SET search_path TO public, pg_temp;

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_updated_resources JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, sv.version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current->'resources') IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_updated_resources := '[]'::jsonb;

    FOR v_resource IN
      SELECT value
        FROM jsonb_array_elements(v_current->'resources') AS value
    LOOP
      IF v_resource->>'key' = 'routes' THEN
        v_resource := jsonb_set(v_resource, '{id_column}', to_jsonb('id'::text), TRUE);
        v_resource := jsonb_set(
          v_resource,
          '{default_sort}',
          jsonb_build_object('column', 'planned_date', 'direction', 'desc'),
          TRUE
        );
      ELSIF v_resource->>'key' = 'route_stops' THEN
        v_resource := jsonb_set(v_resource, '{id_column}', to_jsonb('id'::text), TRUE);
        v_resource := jsonb_set(
          v_resource,
          '{default_sort}',
          jsonb_build_object('column', 'sequence_order', 'direction', 'asc'),
          TRUE
        );
      END IF;

      v_updated_resources := v_updated_resources || jsonb_build_array(v_resource);
    END LOOP;

    v_next := jsonb_set(v_current, '{resources}', v_updated_resources, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Normalize routes registry resources to ui_read_registry schema contract',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

COMMIT;
