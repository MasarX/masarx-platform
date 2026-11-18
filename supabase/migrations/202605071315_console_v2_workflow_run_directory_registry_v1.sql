-- Console V2 workflow run history must read the operator projection, not the
-- raw workflow_runs table shape. The projection already exists as
-- public.v_workflow_run_directory; this registers it in the row-driven read
-- registry so browser-facing Console V2 receives run_id/template/status
-- display fields from the backend contract.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605071315_console_v2_workflow_run_directory_registry_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB;
  v_resource JSONB := jsonb_build_object(
    'key', 'workflow_run_directory',
    'label', 'Workflow run history',
    'relation', 'public.v_workflow_run_directory',
    'id_column', 'id',
    'capability_read', 'workflows.read',
    'select', jsonb_build_array(
      'id',
      'run_id',
      'workflow_template_id',
      'template_id',
      'template_name',
      'template_version',
      'workflow_status',
      'status',
      'entry_point',
      'triggered_by',
      'failure_reason',
      'error',
      'started_at',
      'completed_at',
      'created_at',
      'updated_at',
      'duration_ms',
      'correlation_id',
      'retry_count',
      'max_retries'
    ),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'run_id', 'label', 'Run', 'render_type', 'text'),
      jsonb_build_object('key', 'template_name', 'label', 'Template', 'render_type', 'text'),
      jsonb_build_object('key', 'workflow_status', 'label', 'Status', 'render_type', 'text'),
      jsonb_build_object('key', 'entry_point', 'label', 'Triggered by', 'render_type', 'text'),
      jsonb_build_object('key', 'started_at', 'label', 'Started', 'render_type', 'datetime'),
      jsonb_build_object('key', 'duration_ms', 'label', 'Duration', 'render_type', 'number')
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key', 'id', 'column', 'id', 'op', 'eq'),
      jsonb_build_object('key', 'template', 'column', 'workflow_template_id', 'op', 'eq'),
      jsonb_build_object('key', 'workflow_template_id', 'column', 'workflow_template_id', 'op', 'eq'),
      jsonb_build_object('key', 'workflow_status', 'column', 'workflow_status', 'op', 'eq'),
      jsonb_build_object('key', 'status', 'column', 'status', 'op', 'eq'),
      jsonb_build_object('key', 'correlation_id', 'column', 'correlation_id', 'op', 'eq')
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
             WHEN item->>'key' = 'workflow_run_directory' THEN v_resource
             ELSE item
           END
         ), '[]'::jsonb)
    INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_current->'resources', '[]'::jsonb)) AS item;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_resources) AS item
     WHERE item->>'key' = 'workflow_run_directory'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_resource);
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
           change_reason = 'Register Console V2 workflow run directory resource',
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

SELECT pg_advisory_unlock(hashtext('202605071315_console_v2_workflow_run_directory_registry_v1'));
COMMIT;
