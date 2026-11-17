-- Migration: UI read registry permissions expansion
BEGIN;
SELECT pg_advisory_lock(hashtext('202601041140_ui_read_registry_permissions'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_resources JSONB := '[]'::jsonb;
  v_updated JSONB := '[]'::jsonb;
  v_resource JSONB;
  v_has_users BOOLEAN := FALSE;
  v_manual_review_select JSONB := jsonb_build_array(
    'id','task_type','status','reason','queue_assignment','sla_due_at','assigned_to',
    'shipment_id','resource_type','resource_id','created_at'
  );
  v_manual_review_filters JSONB := jsonb_build_array(
    jsonb_build_object('key','status','column','status','op','eq'),
    jsonb_build_object('key','task_type','column','task_type','op','eq'),
    jsonb_build_object('key','resource_type','column','resource_type','op','eq'),
    jsonb_build_object('key','resource_id','column','resource_id','op','eq')
  );
  v_new_user JSONB := jsonb_build_object(
    'key','users',
    'label','Users',
    'relation','public.users',
    'id_column','id',
    'scope_columns', jsonb_build_object('tenant','organization_id'),
    'capability_read','users.read',
    'select', jsonb_build_array(
      'id','organization_id','email','full_name','user_type','status','access_scope_type',
      'access_scope_id','created_at','last_login_at'
    ),
    'filters', jsonb_build_array(
      jsonb_build_object('key','email','column','email','op','ilike'),
      jsonb_build_object('key','user_type','column','user_type','op','eq'),
      jsonb_build_object('key','status','column','status','op','eq')
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

  FOR v_resource IN SELECT * FROM jsonb_array_elements(v_resources) LOOP
    IF v_resource->>'key' = 'manual_review_tasks' THEN
      v_resource := jsonb_set(v_resource, '{select}', v_manual_review_select, true);
      v_resource := jsonb_set(v_resource, '{filters}', v_manual_review_filters, true);
    END IF;

    IF v_resource->>'key' = 'users' THEN
      v_has_users := TRUE;
    END IF;

    v_updated := v_updated || jsonb_build_array(v_resource);
  END LOOP;

  IF v_has_users IS FALSE THEN
    v_updated := v_updated || jsonb_build_array(v_new_user);
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
        change_reason = 'Add users resource and manual review filters',
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

SELECT pg_advisory_unlock(hashtext('202601041140_ui_read_registry_permissions'));
COMMIT;
