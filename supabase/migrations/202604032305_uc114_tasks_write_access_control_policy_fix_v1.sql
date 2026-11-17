-- Plan: B09 Exception, reattempt & returns loop
-- Migration: UC114 tasks.write access control policy fix v1
-- Date: 2026-04-03
--
-- Purpose:
--   - Ensure access_control_policy includes the canonical tasks.write capability definition.
--   - Ensure ops_admin role maps include tasks.write so NDR owner-claim flows can call assign_task_v1.
--   - Ensure resource_map.tasks resolves write access through tasks.write.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032305_uc114_tasks_write_access_control_policy_fix_v1'));
SET search_path TO public, api, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_tasks_write_capability JSONB := jsonb_build_object(
    'key', 'tasks.write',
    'label', 'Tasks write',
    'description', 'Create/update tasks via approved service paths'
  );
  v_tasks_resource_map JSONB := jsonb_build_object(
    'read', 'tasks.read',
    'write', 'tasks.write'
  );
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_next_caps JSONB := '[]'::jsonb;
  v_cap JSONB;
  v_cap_key TEXT := NULL;
  v_roles JSONB := '[]'::jsonb;
  v_next_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_role_key TEXT := NULL;
  v_role_caps JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    v_next_caps := '[]'::jsonb;
    FOR v_cap IN
      SELECT value
      FROM jsonb_array_elements(v_caps) AS value
    LOOP
      v_cap_key := lower(NULLIF(btrim(COALESCE(v_cap->>'key', '')), ''));
      IF v_cap_key = 'tasks.write' THEN
        v_cap := public.deep_merge_jsonb(v_tasks_write_capability, v_cap);
      END IF;
      v_next_caps := v_next_caps || jsonb_build_array(v_cap);
    END LOOP;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_next_caps) AS item
      WHERE lower(COALESCE(item->>'key', '')) = 'tasks.write'
    ) THEN
      v_next_caps := v_next_caps || jsonb_build_array(v_tasks_write_capability);
    END IF;

    v_next := jsonb_set(v_current, '{capabilities}', v_next_caps, TRUE);
    v_next := jsonb_set(
      v_next,
      '{resource_map,tasks}',
      public.deep_merge_jsonb(COALESCE(v_next#>'{resource_map,tasks}', '{}'::jsonb), v_tasks_resource_map),
      TRUE
    );

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    v_next_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value
      FROM jsonb_array_elements(v_roles) AS value
    LOOP
      v_role_key := lower(NULLIF(btrim(COALESCE(v_role->>'key', '')), ''));
      IF v_role_key = 'ops_admin' THEN
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
          v_role_caps := '[]'::jsonb;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM jsonb_array_elements_text(v_role_caps) AS value
          WHERE value = '*'
             OR lower(value) = 'tasks.write'
        ) THEN
          v_role_caps := v_role_caps || jsonb_build_array('tasks.write');
        END IF;

        v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      END IF;

      v_next_roles := v_next_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := jsonb_set(v_next, '{roles}', v_next_roles, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Ensure access_control_policy grants tasks.write to ops_admin for UC114 queue claim flows.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604032305_uc114_tasks_write_access_control_policy_fix_v1'));
COMMIT;
