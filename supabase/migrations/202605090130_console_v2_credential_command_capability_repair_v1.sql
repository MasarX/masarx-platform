-- Repair Console V2 credential command capabilities to match the backend RPC
-- contract. Provider credential writes are guarded by integration_plugins.write,
-- not the broader integrations.write umbrella.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605090130_console_v2_credential_command_capability_repair_v1'));

DO $$
DECLARE
  v_current JSONB;
  v_updated JSONB;
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

  WITH command_items AS (
    SELECT item, ordinality
      FROM jsonb_array_elements(COALESCE(v_current->'commands', '[]'::jsonb)) WITH ORDINALITY AS e(item, ordinality)
  ),
  patched AS (
    SELECT jsonb_agg(
      CASE
        WHEN item->>'key' IN (
          'integrations.create_credential',
          'integrations.update_credential',
          'integrations.rotate_credential',
          'integrations.revoke_credential'
        )
        THEN jsonb_set(item, '{capability}', to_jsonb('integration_plugins.write'::text), true)
        ELSE item
      END
      ORDER BY ordinality
    ) AS commands
    FROM command_items
  )
  SELECT jsonb_set(v_current, '{commands}', COALESCE(patched.commands, '[]'::jsonb), true)
    INTO v_updated
    FROM patched;

  IF v_updated IS DISTINCT FROM v_current THEN
    WITH current AS (
      SELECT s.settings_version_id,
             sv.version,
             sv.value
        FROM public.settings s
        JOIN public.settings_versions sv ON sv.id = s.settings_version_id
       WHERE s.category = 'ui_command_registry'
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
       LIMIT 1
    ),
    applied AS (
      UPDATE public.settings_versions sv
         SET value = v_updated,
             version = current.version + 1,
             change_reason = 'Repair Console V2 credential command capability',
             approved_at = now(),
             effective_from = now()
        FROM current
       WHERE sv.id = current.settings_version_id
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
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605090130_console_v2_credential_command_capability_repair_v1'));

COMMIT;
