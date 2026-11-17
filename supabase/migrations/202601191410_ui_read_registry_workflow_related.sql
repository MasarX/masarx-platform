-- Migration: Add related sections for workflow templates/runs (steps together)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191410_ui_read_registry_workflow_related'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_related_templates JSONB := jsonb_build_array(
    jsonb_build_object(
      'resource','workflow_template_steps',
      'label','Steps',
      'filter_key','workflow_template_id',
      'from','id',
      'limit', 200
    )
  );
  v_related_runs JSONB := jsonb_build_array(
    jsonb_build_object(
      'resource','workflow_run_steps',
      'label','Steps',
      'filter_key','workflow_run_id',
      'from','id',
      'limit', 400
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
    IF v_resource->>'key' = 'workflow_templates' THEN
      v_resource := jsonb_set(v_resource, '{related}', v_related_templates, true);
    ELSIF v_resource->>'key' = 'workflow_runs' THEN
      v_resource := jsonb_set(v_resource, '{related}', v_related_runs, true);
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
           change_reason = 'Add workflow related sections (steps)',
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

SELECT pg_advisory_unlock(hashtext('202601191410_ui_read_registry_workflow_related'));
COMMIT;

