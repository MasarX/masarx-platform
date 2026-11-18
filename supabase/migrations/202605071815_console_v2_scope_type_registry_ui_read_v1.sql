-- Migration: Register scope_type_registry for live Console V2 reads
BEGIN;
SELECT pg_advisory_lock(hashtext('202605071815_console_v2_scope_type_registry_ui_read_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_has_scope_type_registry BOOLEAN := FALSE;
  v_scope_type_registry JSONB := jsonb_build_object(
    'key', 'scope_type_registry',
    'label', 'Scope type registry',
    'relation', 'public.scope_type_registry',
    'id_column', 'scope_type',
    'capability_read', 'settings.read',
    'select', jsonb_build_array(
      'scope_type',
      'description',
      'entity_table',
      'id_column',
      'context_keys',
      'is_enabled',
      'ladder_rank',
      'settings_write_requires_platform_user',
      'created_at',
      'updated_at'
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'scope_type', 'label', 'Scope', 'mono', true, 'sortable', true, 'filterable', true),
      jsonb_build_object('key', 'description', 'label', 'Description'),
      jsonb_build_object('key', 'ladder_rank', 'label', 'Ladder rank', 'align', 'right', 'mono', true, 'sortable', true, 'type', 'number'),
      jsonb_build_object('key', 'entity_table', 'label', 'Entity table', 'mono', true),
      jsonb_build_object('key', 'is_enabled', 'label', 'Enabled', 'sortable', true, 'filterable', true)
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'scope_type', 'column', 'scope_type', 'op', 'eq'),
      jsonb_build_object('key', 'is_enabled', 'column', 'is_enabled', 'op', 'eq')
    ),
    'default_sort', jsonb_build_object('column', 'ladder_rank', 'direction', 'asc')
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

  v_resources := COALESCE(v_current->'resources', '[]'::jsonb);

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'scope_type_registry' THEN
      v_has_scope_type_registry := TRUE;
      v_updated := v_updated || jsonb_build_array(v_scope_type_registry);
    ELSE
      v_updated := v_updated || jsonb_build_array(v_resource);
    END IF;
  END LOOP;

  IF v_has_scope_type_registry IS FALSE THEN
    v_updated := v_updated || jsonb_build_array(v_scope_type_registry);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
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
           change_reason = 'Register scope_type_registry for Console V2 live reads',
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

SELECT pg_advisory_unlock(hashtext('202605071815_console_v2_scope_type_registry_ui_read_v1'));
COMMIT;
