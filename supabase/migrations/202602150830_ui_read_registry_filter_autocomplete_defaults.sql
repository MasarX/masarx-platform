-- Plan: PLAN-202602-ux-upgrade-notion-level-v1 / Step: S02
-- Migration: Enable config-driven filter value autocomplete defaults in ui_read_registry (global)
BEGIN;

SELECT pg_advisory_lock(hashtext('202602150830_ui_read_registry_filter_autocomplete_defaults'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_item JSONB;
  v_filters JSONB;
  v_next_filters JSONB;
  v_filter JSONB;
  v_autocomplete JSONB := jsonb_build_object(
    'enabled', true,
    'source', 'distinct_values',
    'min_query_length', 2,
    'limit', 25
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_read_registry global settings missing';
  END IF;

  FOR v_item IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) LOOP
    v_filters := v_item->'filters';
    IF jsonb_typeof(v_filters) = 'array' THEN
      v_next_filters := '[]'::jsonb;
      FOR v_filter IN SELECT * FROM jsonb_array_elements(v_filters) LOOP
        IF NOT (v_filter ? 'value_autocomplete') THEN
          v_filter := jsonb_set(v_filter, '{value_autocomplete}', v_autocomplete, true);
        END IF;
        v_next_filters := v_next_filters || jsonb_build_array(v_filter);
      END LOOP;
      v_item := jsonb_set(v_item, '{filters}', v_next_filters, true);
    END IF;
    v_resources := v_resources || jsonb_build_array(v_item);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Enable ui_read_registry filter value autocomplete defaults',
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
   WHERE s.category = 'ui_read_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202602150830_ui_read_registry_filter_autocomplete_defaults'));

COMMIT;

