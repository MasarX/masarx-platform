-- Migration: Grant workflow_runs.read to tenant roles (account_manager, client_admin)
BEGIN;
SELECT pg_advisory_lock(hashtext('202601192310_access_control_policy_workflow_runs_read'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_entry JSONB;
  v_role_key TEXT;
  v_keys JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_capabilities) AS item
     WHERE item->>'key' = 'workflow_runs.read'
  ) THEN
    v_capabilities :=
      v_capabilities ||
      jsonb_build_array(
        jsonb_build_object(
          'key','workflow_runs.read',
          'label','Workflow runs read'
        )
      );
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_roles) LOOP
    v_role_key := NULLIF(v_entry->>'key', '');
    v_keys := COALESCE(v_entry->'capability_keys', '[]'::jsonb);

    IF v_role_key IN ('ops_admin','account_manager','client_admin') THEN
      IF jsonb_typeof(v_keys) = 'array'
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_keys) AS value
           WHERE value = 'workflow_runs.read' OR value = '*'
         ) THEN
        v_entry := jsonb_set(
          v_entry,
          '{capability_keys}',
          v_keys || jsonb_build_array('workflow_runs.read'),
          true
        );
      END IF;
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_entry);
  END LOOP;

  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Grant workflow_runs.read to tenant roles',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601192310_access_control_policy_workflow_runs_read'));
COMMIT;

