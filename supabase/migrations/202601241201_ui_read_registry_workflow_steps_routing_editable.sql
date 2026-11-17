-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04
-- Migration: ui_read_registry workflow_template_steps routing + metadata editable
BEGIN;
SELECT pg_advisory_lock(hashtext('202601241201_ui_read_registry_workflow_steps_routing_editable'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_columns JSONB := '[]'::jsonb;
  v_add_columns JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','condition_jsonlogic',
      'label','Condition (JSONLogic)',
      'edit_mode','modal',
      'edit_type','json',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','next_operation_name',
      'label','Next operation',
      'edit_mode','modal',
      'edit_type','text',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','next_operation_priority',
      'label','Next priority',
      'edit_mode','modal',
      'edit_type','number',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','next_operation_delay_seconds',
      'label','Next delay seconds',
      'edit_mode','modal',
      'edit_type','number',
      'edit_permission','workflow_runs.write'
    ),
    jsonb_build_object(
      'key','metadata',
      'label','Metadata',
      'edit_mode','modal',
      'edit_type','json',
      'edit_permission','workflow_runs.write'
    )
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
      v_columns := COALESCE(v_resource->'columns', '[]'::jsonb);

      v_columns := COALESCE((
        SELECT jsonb_agg(col) FILTER (WHERE col IS NOT NULL)
        FROM jsonb_array_elements(v_columns) AS col
        WHERE col->>'key' NOT IN (
          'condition_jsonlogic',
          'next_operation_name',
          'next_operation_priority',
          'next_operation_delay_seconds',
          'metadata'
        )
      ), '[]'::jsonb);

      v_columns := v_columns || v_add_columns;
      v_resource := jsonb_set(v_resource, '{columns}', v_columns, true);
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
           change_reason = 'Enable workflow_template_steps routing + metadata edit',
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

SELECT pg_advisory_unlock(hashtext('202601241201_ui_read_registry_workflow_steps_routing_editable'));
COMMIT;

