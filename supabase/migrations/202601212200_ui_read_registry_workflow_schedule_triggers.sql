-- Migration: UI read registry workflow_schedule_triggers resource (select-all + safe edit metadata)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601212200_ui_read_registry_workflow_schedule_triggers'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_existing JSONB;
  v_found BOOLEAN := false;
  v_columns JSONB;
  v_capability_write TEXT := 'workflow_runs.write';
  v_new JSONB;
  v_protected_cols TEXT[] := ARRAY[
    'id',
    'organization_id',
    'scope_type',
    'scope_id',
    'workflow_template_id',
    'next_run_at',
    'last_run_at',
    'last_run_id',
    'last_error',
    'last_error_at',
    'created_by',
    'created_at',
    'updated_at'
  ];
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

  SELECT jsonb_agg(
    jsonb_strip_nulls(
      jsonb_build_object(
        'key', cols.column_name,
        'label', initcap(replace(cols.column_name, '_', ' ')),
        'render_type',
          CASE
            WHEN cols.data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
            WHEN cols.data_type = 'date' THEN 'date'
            WHEN cols.data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
            WHEN cols.data_type = 'boolean' THEN 'boolean'
            WHEN cols.data_type = 'uuid' THEN 'id'
            WHEN cols.data_type IN ('json','jsonb') THEN 'json'
            WHEN cols.column_name ~* '_at$' THEN 'datetime'
            WHEN cols.column_name ~* '_date$' THEN 'date'
            ELSE 'text'
          END,
        'format_options', NULL,
        'edit_mode',
          CASE
            WHEN v_capability_write IS NULL THEN 'none'
            WHEN cols.column_name = ANY(v_protected_cols) THEN 'none'
            WHEN cols.data_type IN ('json','jsonb') THEN 'form'
            ELSE 'inline'
          END,
        'edit_type',
          CASE
            WHEN cols.data_type IN ('timestamp with time zone', 'timestamp without time zone') THEN 'datetime'
            WHEN cols.data_type = 'date' THEN 'date'
            WHEN cols.data_type IN ('integer','bigint','smallint','numeric','double precision','real') THEN 'number'
            WHEN cols.data_type = 'boolean' THEN 'boolean'
            WHEN cols.data_type IN ('json','jsonb') THEN 'textarea'
            ELSE 'text'
          END,
        'edit_permission',
          CASE
            WHEN v_capability_write IS NULL THEN NULL
            WHEN cols.column_name = ANY(v_protected_cols) THEN NULL
            ELSE v_capability_write
          END
      )
    )
    ORDER BY cols.ordinal_position
  )
  INTO v_columns
  FROM information_schema.columns cols
  WHERE cols.table_schema = 'public'
    AND cols.table_name = 'workflow_schedule_triggers';

  v_new := jsonb_build_object(
    'key','workflow_schedule_triggers',
    'label','Workflow schedule triggers',
    'relation','public.workflow_schedule_triggers',
    'id_column','id',
    'capability_read','workflow_runs.read',
    'capability_write', v_capability_write,
    'scope_columns', jsonb_build_object(
      'tenant','scope_id',
      'client','scope_id',
      'sender','scope_id'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','workflow_template_id','column','workflow_template_id','op','eq'),
      jsonb_build_object('key','enabled','column','enabled','op','eq')
    ),
    'default_sort', jsonb_build_object('column','next_run_at','direction','asc'),
    'columns', COALESCE(v_columns, '[]'::jsonb)
  );

  FOR v_existing IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_existing->>'key' = 'workflow_schedule_triggers' THEN
      v_found := true;
      v_updated := v_updated || jsonb_build_array(v_new);
    ELSE
      v_updated := v_updated || jsonb_build_array(v_existing);
    END IF;
  END LOOP;

  IF v_found IS DISTINCT FROM true THEN
    v_updated := v_updated || jsonb_build_array(v_new);
  END IF;

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
        change_reason = 'Expose workflow_schedule_triggers resource (filters + safe edit metadata)',
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

SELECT pg_advisory_unlock(hashtext('202601212200_ui_read_registry_workflow_schedule_triggers'));
COMMIT;

