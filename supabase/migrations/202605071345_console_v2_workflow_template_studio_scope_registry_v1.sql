-- Console V2 workflow template studio must be scoped to the active tenant and
-- backed by operator projection resources, not broad cross-tenant raw lists.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605071345_console_v2_workflow_template_studio_scope_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_directory_resource JSONB := jsonb_build_object(
    'key', 'workflow_template_directory',
    'label', 'Workflow template directory',
    'relation', 'public.v_workflow_template_directory',
    'id_column', 'workflow_template_id',
    'capability_read', 'workflows.read',
    'select', jsonb_build_array(
      'id',
      'workflow_template_id',
      'template_id',
      'name',
      'description',
      'version',
      'status',
      'scope_type',
      'scope_id',
      'created_at',
      'published_at',
      'retired_at',
      'step_count',
      'active_run_count',
      'total_run_count',
      'last_run_at',
      'last_run_status',
      'binding_count',
      'is_published'
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'name', 'label', 'Template', 'render_type', 'text'),
      jsonb_build_object('key', 'status', 'label', 'Status', 'render_type', 'text'),
      jsonb_build_object('key', 'step_count', 'label', 'Steps', 'render_type', 'number'),
      jsonb_build_object('key', 'total_run_count', 'label', 'Runs', 'render_type', 'number')
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'workflow_template_id', 'column', 'workflow_template_id', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'scope_type', 'column', 'scope_type', 'op', 'eq'),
      jsonb_build_object('key', 'scope_id', 'column', 'scope_id', 'op', 'eq'),
      jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike')
    ),
    'default_sort', jsonb_build_object('column', 'created_at', 'direction', 'desc')
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

  SELECT COALESCE(jsonb_agg(
           CASE
             WHEN item->>'key' = 'workflow_templates' THEN
               item || jsonb_build_object(
                 'filters', jsonb_build_array(
                   jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
                   jsonb_build_object('key', 'scope_type', 'column', 'scope_type', 'op', 'eq'),
                   jsonb_build_object('key', 'scope_id', 'column', 'scope_id', 'op', 'eq'),
                   jsonb_build_object('key', 'name', 'column', 'name', 'op', 'ilike')
                 )
               )
             WHEN item->>'key' = 'workflow_template_directory' THEN v_directory_resource
             ELSE item
           END
         ), '[]'::jsonb)
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
     WHERE item->>'key' = 'workflow_template_directory'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_directory_resource);
  END IF;

  v_current := jsonb_set(v_current, '{resources}', v_resources, true);

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
           change_reason = 'Scope Console V2 workflow template studio resources',
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

SELECT pg_advisory_unlock(hashtext('202605071345_console_v2_workflow_template_studio_scope_registry_v1'));
COMMIT;
