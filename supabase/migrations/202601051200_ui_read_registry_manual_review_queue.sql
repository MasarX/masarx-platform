-- Migration: UI read registry manual review queue fields
BEGIN;
SELECT pg_advisory_lock(hashtext('202601051200_ui_read_registry_manual_review_queue'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_select JSONB := jsonb_build_array(
    'id',
    'task_type',
    'status',
    'reason',
    'queue_assignment',
    'assigned_to',
    'sla_due_at',
    'resource_type',
    'resource_id',
    'resolution_outcome',
    'resolution_notes',
    'resolved_by',
    'resolved_at',
    'created_at',
    'updated_at'
  );
  v_filters JSONB := jsonb_build_array(
    jsonb_build_object('key','status','column','status','op','eq'),
    jsonb_build_object('key','task_type','column','task_type','op','eq'),
    jsonb_build_object('key','queue_assignment','column','queue_assignment','op','eq'),
    jsonb_build_object('key','assigned_to','column','assigned_to','op','eq'),
    jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
    jsonb_build_object('key','resource_id','column','resource_id','op','eq'),
    jsonb_build_object('key','resolution_outcome','column','resolution_outcome','op','eq')
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
    IF v_resource->>'key' = 'manual_review_tasks' THEN
      v_resource := jsonb_set(v_resource, '{select}', v_select, true);
      v_resource := jsonb_set(v_resource, '{filters}', v_filters, true);
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
        change_reason = 'Expand manual review queue fields and filters',
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

SELECT pg_advisory_unlock(hashtext('202601051200_ui_read_registry_manual_review_queue'));
COMMIT;
