-- Plan: PLAN-202602-fieldops-web-preview-support-v1 / Step: S98
-- Migration: Ensure mobile task capabilities exist in access_control_policy defaults
-- Purpose:
--   - Keep mobile module access policy-driven (no frontend bypass).
--   - Add tasks.read/tasks.complete capabilities to global access_control_policy when missing.
--   - Ensure ops_admin role includes both capabilities so Field Ops mobile modules are actionable.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602111200_access_control_policy_mobile_tasks_caps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_role_key TEXT;
  v_role_caps JSONB;
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
     WHERE item->>'key' = 'tasks.read'
  ) THEN
    v_capabilities :=
      v_capabilities ||
      jsonb_build_array(
        jsonb_build_object(
          'key', 'tasks.read',
          'label', 'Tasks read',
          'description', 'Read tasks and task events'
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_capabilities) AS item
     WHERE item->>'key' = 'tasks.complete'
  ) THEN
    v_capabilities :=
      v_capabilities ||
      jsonb_build_array(
        jsonb_build_object(
          'key', 'tasks.complete',
          'label', 'Tasks complete',
          'description', 'Complete and transition tasks'
        )
      );
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  FOR v_role IN SELECT * FROM jsonb_array_elements(v_roles) LOOP
    v_role_key := NULLIF(v_role->>'key', '');
    v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);

    IF v_role_key = 'ops_admin' THEN
      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'tasks.read' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('tasks.read'),
          true
        );
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      END IF;

      IF jsonb_typeof(v_role_caps) = 'array'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = 'tasks.complete' OR value = '*'
         ) THEN
        v_role := jsonb_set(
          v_role,
          '{capability_keys}',
          v_role_caps || jsonb_build_array('tasks.complete'),
          true
        );
      END IF;
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_role);
  END LOOP;

  v_next := v_current;
  v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
  v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value
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
           change_reason = 'Add mobile task capabilities to access_control_policy',
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

SELECT pg_advisory_unlock(hashtext('202602111200_access_control_policy_mobile_tasks_caps_v1'));
COMMIT;
