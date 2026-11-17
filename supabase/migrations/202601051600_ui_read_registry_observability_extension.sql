BEGIN;
SELECT pg_advisory_lock(hashtext('202601051600_ui_read_registry_observability_extension'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_domain_events JSONB := jsonb_build_object(
    'key','domain_events',
    'label','Domain events',
    'relation','public.domain_events',
    'id_column','id',
    'scope_columns', jsonb_build_object('tenant','organization_id'),
    'capability_read','requests.read',
    'select', jsonb_build_array(
      'id','organization_id','event_type','resource_type','resource_id',
      'workflow_run_id','correlation_id','status','created_at','processed_at',
      'error_reason','payload'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','event_type','column','event_type','op','ilike'),
      jsonb_build_object('key','status','column','status','op','eq'),
      jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
      jsonb_build_object('key','resource_id','column','resource_id','op','eq'),
      jsonb_build_object('key','correlation_id','column','correlation_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
  );
  v_workflow_runs JSONB := jsonb_build_object(
    'key','workflow_runs',
    'label','Workflow runs',
    'relation','public.workflow_runs',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'select', jsonb_build_array(
      'id','workflow_template_id','workflow_template_version',
      'triggered_by_request_id','entry_point','workflow_status','current_step_id',
      'retry_count','failure_reason','context','metadata','created_at','started_at',
      'updated_at','completed_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','workflow_template_id','column','workflow_template_id','op','eq'),
      jsonb_build_object('key','workflow_status','column','workflow_status','op','eq'),
      jsonb_build_object('key','entry_point','column','entry_point','op','eq'),
      jsonb_build_object('key','triggered_by_request_id','column','triggered_by_request_id','op','eq')
    ),
    'default_sort', jsonb_build_object('column','created_at','direction','desc')
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
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item
    WHERE item->>'key' = 'domain_events'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_domain_events);
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_resources) AS item
    WHERE item->>'key' = 'workflow_runs'
  ) THEN
    v_resources := v_resources || jsonb_build_array(v_workflow_runs);
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
        change_reason = 'Add domain events and workflow runs resources',
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

SELECT pg_advisory_unlock(hashtext('202601051600_ui_read_registry_observability_extension'));
COMMIT;
