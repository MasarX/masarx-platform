-- Migration: Console V2 workflow capability scoped policy repair
-- Purpose:
--   Tenant/client/sender access_control_policy rows can override the global
--   policy. Keep every scoped policy aligned with Console V2 registry gates
--   that now read workflow surfaces through workflows.read/write.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605082155_console_v2_workflows_capability_scope_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_policy RECORD;
  v_current JSONB;
  v_next JSONB;
  v_capabilities JSONB;
  v_roles JSONB;
  v_updated_roles JSONB;
  v_role JSONB;
  v_keys JSONB;
BEGIN
  FOR v_policy IN
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.value,
           sv.version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'access_control_policy'
  LOOP
    v_current := v_policy.value;
    v_capabilities := COALESCE(v_current->'capabilities', '[]'::jsonb);
    v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
    v_updated_roles := '[]'::jsonb;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_capabilities) AS item
       WHERE item->>'key' = 'workflows.read'
    ) THEN
      v_capabilities := v_capabilities || jsonb_build_array(
        jsonb_build_object(
          'key', 'workflows.read',
          'label', 'Workflows read',
          'category', 'workflow',
          'description', 'Read Console workflow templates, bindings, runs, and intake provenance.'
        )
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_capabilities) AS item
       WHERE item->>'key' = 'workflows.write'
    ) THEN
      v_capabilities := v_capabilities || jsonb_build_array(
        jsonb_build_object(
          'key', 'workflows.write',
          'label', 'Workflows write',
          'category', 'workflow',
          'description', 'Manage Console workflow templates, bindings, policies, and review actions.'
        )
      );
    END IF;

    FOR v_role IN SELECT * FROM jsonb_array_elements(v_roles) LOOP
      v_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);

      IF jsonb_typeof(v_keys) = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_keys) AS key
            WHERE key IN ('*', 'workflow_runs.read', 'workflow_runs.write', 'workflows.write')
         )
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_keys) AS key
            WHERE key IN ('*', 'workflows.read')
         ) THEN
        v_keys := v_keys || jsonb_build_array('workflows.read');
      END IF;

      IF jsonb_typeof(v_keys) = 'array'
         AND EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_keys) AS key
            WHERE key IN ('*', 'workflow_runs.write')
         )
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(v_keys) AS key
            WHERE key IN ('*', 'workflows.write')
         ) THEN
        v_keys := v_keys || jsonb_build_array('workflows.write');
      END IF;

      IF jsonb_typeof(v_keys) = 'array' THEN
        v_role := jsonb_set(v_role, '{capability_keys}', v_keys, true);
      END IF;

      v_updated_roles := v_updated_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := v_current;
    v_next := jsonb_set(v_next, '{capabilities}', v_capabilities, true);
    v_next := jsonb_set(v_next, '{roles}', v_updated_roles, true);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_policy.version + 1,
             change_reason = 'Align scoped Console V2 workflow capability aliases with workflows.read/write registry gates',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_policy.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_policy.settings_id;
    END IF;
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.setting_resolution_cache') IS NOT NULL THEN
    DELETE FROM public.setting_resolution_cache
     WHERE cache_key LIKE 'access_control_policy:%';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605082155_console_v2_workflows_capability_scope_repair_v1'));
COMMIT;
