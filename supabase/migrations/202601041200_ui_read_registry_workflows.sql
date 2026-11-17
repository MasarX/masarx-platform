-- Migration: UI read registry workflow resources
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041200_ui_read_registry_workflows'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_workflow_templates JSONB := jsonb_build_object(
    'key','workflow_templates',
    'label','Workflow templates',
    'relation','public.workflow_templates',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'select', jsonb_build_array(
      'id','name','status','version','scope_type','scope_id','created_at','published_at','retired_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','scope_type','column','scope_type','op','eq'),
      jsonb_build_object('key','name','column','name','op','ilike')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );
  v_workflow_template_steps JSONB := jsonb_build_object(
    'key','workflow_template_steps',
    'label','Workflow template steps',
    'relation','public.workflow_template_steps',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'select', jsonb_build_array(
      'id','workflow_template_id','sequence_order','operation_name','transition_condition',
      'handler_key','enabled','created_at','updated_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','workflow_template_id','column','workflow_template_id','op','eq'),
      jsonb_build_object('key','operation_name','column','operation_name','op','ilike'),
      jsonb_build_object('key','enabled','column','enabled','op','eq')
    ),
    'default_sort', jsonb_build_object('column','sequence_order','direction','asc')
  );
  v_workflow_run_steps JSONB := jsonb_build_object(
    'key','workflow_run_steps',
    'label','Workflow run steps',
    'relation','public.workflow_run_steps',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'select', jsonb_build_array(
      'id','workflow_run_id','sequence_order','step_status','operation_name','handler_key',
      'enqueued_at','operation_started_at','operation_completed_at','duration_ms'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','workflow_run_id','column','workflow_run_id','op','eq'),
      jsonb_build_object('key','step_status','column','step_status','op','eq'),
      jsonb_build_object('key','operation_name','column','operation_name','op','ilike')
    ),
    'default_sort', jsonb_build_object('column','sequence_order','direction','asc')
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

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'workflow_templates'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_workflow_templates);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'workflow_template_steps'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_workflow_template_steps);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item WHERE item->>'key' = 'workflow_run_steps'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_workflow_run_steps);
  END IF;

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
        change_reason = 'Add workflow template and step resources',
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

SELECT pg_advisory_unlock(hashtext('202601041200_ui_read_registry_workflows'));
COMMIT;
