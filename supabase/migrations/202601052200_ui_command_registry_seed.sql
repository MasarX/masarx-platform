-- Migration: Seed UI command registry defaults
BEGIN;
SELECT pg_advisory_lock(hashtext('202601052200_ui_command_registry_seed'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_commands JSONB := '[]'::jsonb;
  v_candidate JSONB;
  v_new JSONB := jsonb_build_array(
    jsonb_build_object(
      'key','settings_change_request',
      'label','Request settings change',
      'description','Submit a configuration change for approval through the workflow engine.',
      'capability','settings.request',
      'schema_category', NULL,
      'workflow_key','request_settings_change_v1'
    ),
    jsonb_build_object(
      'key','access_policy_change_request',
      'label','Request access policy change',
      'description','Request an access policy update for approval.',
      'capability','access_policy.request',
      'schema_category','access_control_policy',
      'workflow_key','ui_request_access_policy_change_v1'
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'ui_command_registry global settings missing';
  END IF;

  v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
  FOR v_candidate IN SELECT * FROM jsonb_array_elements(v_new) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_commands) AS item
      WHERE item->>'key' = v_candidate->>'key'
    ) THEN
      v_commands := v_commands || jsonb_build_array(v_candidate);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{commands}', v_commands, true);

  WITH current AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_current,
           version = current.version + 1,
           change_reason = 'Seed UI command registry defaults',
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
   WHERE s.category = 'ui_command_registry'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
     AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202601052200_ui_command_registry_seed'));
COMMIT;
