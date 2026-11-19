-- Console V2 Review Queue task activity readback.
--
-- Review Queue task completion already writes canonical task_events rows.
-- Expose that ledger through ui_read_registry so the same open task drawer can
-- refresh backend-backed activity without falling back to raw table reads,
-- synthetic timelines, or browser reloads.

BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $registry$
DECLARE
  v_setting RECORD;
  v_current JSONB;
  v_resources JSONB;
  v_next JSONB;
  v_task_events_resource JSONB := jsonb_build_object(
    'key', 'task_events',
    'label', 'Task events',
    'relation', 'public.task_events',
    'id_column', 'id',
    'capability_read', 'tasks.read',
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc'),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'task_id', 'column', 'task_id', 'op', 'eq'),
      jsonb_build_object('key', 'organization_id', 'column', 'organization_id', 'op', 'eq'),
      jsonb_build_object('key', 'event_type', 'column', 'event_type', 'op', 'eq'),
      jsonb_build_object('key', 'actor_user_id', 'column', 'actor_user_id', 'op', 'eq'),
      jsonb_build_object('key', 'ops_session_id', 'column', 'ops_session_id', 'op', 'eq')
    )
  );
BEGIN
  FOR v_setting IN
    SELECT s.id AS setting_id,
           s.settings_version_id,
           sv.version,
           COALESCE(sv.value, s.cached_value, '{"resources":[]}'::jsonb) AS value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_setting.value, '{"resources":[]}'::jsonb);

    SELECT COALESCE(jsonb_agg(resource), '[]'::jsonb)
      INTO v_resources
      FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS resource
     WHERE resource->>'key' <> 'task_events';

    v_next := jsonb_set(
      v_current,
      '{resources}',
      COALESCE(v_resources, '[]'::jsonb) || jsonb_build_array(v_task_events_resource),
      TRUE
    );

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_setting.version + 1,
           change_reason = 'Console V2: register task_events readback for Review Queue activity',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_setting.settings_version_id
       AND value IS DISTINCT FROM v_next;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_setting.setting_id
       AND cached_value IS DISTINCT FROM v_next;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%'
      OR cache_key LIKE 'ui_list_resource:%task_events%';
END;
$registry$;

COMMIT;
