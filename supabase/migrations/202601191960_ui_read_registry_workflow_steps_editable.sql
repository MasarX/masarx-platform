-- Migration: Make workflow_template_steps editable/reorderable (ui_read_registry)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191960_ui_read_registry_workflow_steps_editable'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','sequence_order',
      'label','Order'
    ),
    jsonb_build_object(
      'key','operation_name',
      'label','Operation',
      'edit_mode','inline',
      'edit_type','text',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','transition_condition',
      'label','Transition',
      'edit_mode','inline',
      'edit_type','text',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','handler_key',
      'label','Handler',
      'edit_mode','inline',
      'edit_type','text',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','enabled',
      'label','Enabled',
      'edit_mode','inline',
      'edit_type','boolean',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','manual_action_required',
      'label','Manual',
      'edit_mode','inline',
      'edit_type','boolean',
      'edit_permission','workflow_runs.write'
    )
  );
  v_reorder JSONB := jsonb_build_object(
    'order_column','sequence_order',
    'group_column','workflow_template_id',
    'require_full', true,
    'capability','workflow_runs.write',
    'post_action','workflow_refresh_steps_checksum'
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
    IF v_resource->>'key' = 'workflow_template_steps' THEN
      v_resource := jsonb_set(v_resource, '{columns}', v_columns, true);
      v_resource := jsonb_set(v_resource, '{reorder}', v_reorder, true);
      v_resource := jsonb_set(v_resource, '{capability_write}', to_jsonb('workflow_runs.write'::text), true);
    END IF;
    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  v_current := jsonb_set(v_current, '{resources}', v_updated, true);

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
           change_reason = 'Enable workflow_template_steps reorder + inline edit',
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

SELECT pg_advisory_unlock(hashtext('202601191960_ui_read_registry_workflow_steps_editable'));
COMMIT;

