-- Migration: Operation handlers plugin edit RBAC
-- Purpose: Allow platform ops to edit workflow studio plugin metadata (row-driven) while protecting handler identity fields.
-- Plan: PLAN-202601-workflow-studio-dnd / Step: S04

BEGIN;
SELECT pg_advisory_lock(hashtext('202601211630_operation_handlers_plugin_edit_rbac'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Access control capability: operation_handlers.write (ops-only)
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  v_current JSONB;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_cap JSONB := jsonb_build_object(
    'key','operation_handlers.write',
    'label','Operation handlers write',
    'category','workflow',
    'description','Edit workflow operation handler UI metadata (plugin catalogue).'
  );
  v_role JSONB;
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

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF NOT EXISTS (
    SELECT 1
    FROM jsonb_array_elements(v_caps) AS item
    WHERE item->>'key' = 'operation_handlers.write'
  ) THEN
    v_caps := v_caps || jsonb_build_array(v_cap);
  END IF;

  v_roles := '[]'::jsonb;
  FOR v_role IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' = 'ops_admin' THEN
      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
            UNION ALL SELECT 'operation_handlers.write'::text AS cap
          ) AS caps
          ORDER BY cap
        )),
        false
      );
    END IF;
    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, true);
  v_current := jsonb_set(v_current, '{roles}', v_roles, true);

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
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Add operation_handlers.write capability',
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
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

-- ---------------------------------------------------------------------------
-- 2) RLS: ops can UPDATE operation_handlers (via ui_update_resource_v1), service_role keeps full access.
-- ---------------------------------------------------------------------------
DROP POLICY IF EXISTS operation_handlers_authenticated_update ON public.operation_handlers;
CREATE POLICY operation_handlers_authenticated_update ON public.operation_handlers
  FOR UPDATE
  TO authenticated
  USING (public.user_has_capability_v1('operation_handlers.write'))
  WITH CHECK (public.user_has_capability_v1('operation_handlers.write'));

-- ---------------------------------------------------------------------------
-- 3) Guardrail: handler identity fields are service-only (ops edits limited to UI metadata).
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.operation_handlers_restrict_identity_updates_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF (
    NEW.handler_schema IS DISTINCT FROM OLD.handler_schema
    OR NEW.handler_name IS DISTINCT FROM OLD.handler_name
    OR NEW.handler_signature IS DISTINCT FROM OLD.handler_signature
    OR NEW.handler_version IS DISTINCT FROM OLD.handler_version
  ) THEN
    IF current_user NOT IN ('postgres', 'service_role') THEN
      RAISE EXCEPTION 'operation_handlers identity fields are service-only'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS operation_handlers_restrict_identity_updates ON public.operation_handlers;
CREATE TRIGGER operation_handlers_restrict_identity_updates
  BEFORE UPDATE ON public.operation_handlers
  FOR EACH ROW
  EXECUTE FUNCTION public.operation_handlers_restrict_identity_updates_v1();

SELECT pg_advisory_unlock(hashtext('202601211630_operation_handlers_plugin_edit_rbac'));
COMMIT;

