-- Migration: Remove Console route targets from Billing commands with no real workflow.
--
-- The command palette may route contextual, implemented Billing actions to the
-- Billing module for discovery. It must not route unsupported actions such as
-- mark-paid or re-issue as if clicking the command can start that workflow.

BEGIN;

DO $$
DECLARE
  v_scope RECORD;
  v_commands JSONB;
  v_updated JSONB;
BEGIN
  FOR v_scope IN
    SELECT s.scope_type,
           s.scope_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_command_registry'
  LOOP
    v_commands := COALESCE(v_scope.value->'commands', '[]'::jsonb);

    WITH command_items AS (
      SELECT item, ordinality
        FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS e(item, ordinality)
    ),
    patched AS (
      SELECT COALESCE(
        jsonb_agg(
          CASE
            WHEN item->>'key' IN (
              'invoices.add_line',
              'invoices.remove_line',
              'invoices.mark_paid',
              'invoices.reissue'
            )
              THEN item #- '{route_targets,console}'
            ELSE item
          END
          ORDER BY ordinality
        ),
        '[]'::jsonb
      ) AS commands
      FROM command_items
    )
    SELECT jsonb_set(v_scope.value, '{commands}', patched.commands, true)
      INTO v_updated
      FROM patched;

    UPDATE public.settings_versions sv
       SET value = v_updated,
           version = v_scope.version + 1,
           change_reason = 'Disable unsupported Billing command palette routes',
           approved_at = now(),
           effective_from = now()
     WHERE sv.id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM sv.value;

    UPDATE public.settings s
       SET cached_value = v_updated,
           last_updated = now()
     WHERE s.category = 'ui_command_registry'
       AND s.scope_type = v_scope.scope_type
       AND s.scope_id IS NOT DISTINCT FROM v_scope.scope_id
       AND s.settings_version_id = v_scope.settings_version_id
       AND v_updated IS DISTINCT FROM s.cached_value;
  END LOOP;
END $$;

COMMIT;
