-- Migration: shipments.print_labels interactive budget retune v4
-- Purpose:
--   - Give single-label sync-wait runs enough inline budget to finish in one interactive pass more often.
--   - Keep the change row-driven through ui_command_registry workflow_start knobs.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603063320_shipments_print_labels_interactive_budget_v4'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_settings_id uuid;
  v_version_id uuid;
  v_value jsonb;
  v_commands jsonb;
  v_updated_commands jsonb;
BEGIN
  SELECT s.id, s.settings_version_id, sv.value
  INTO v_settings_id, v_version_id, v_value
  FROM public.settings s
  JOIN public.settings_versions sv
    ON sv.id = s.settings_version_id
  WHERE s.category = 'ui_command_registry'
    AND s.scope_type = 'global'
    AND s.scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
  ORDER BY s.last_updated DESC
  LIMIT 1;

  IF v_settings_id IS NULL OR v_version_id IS NULL THEN
    RAISE EXCEPTION 'Global ui_command_registry settings missing';
  END IF;

  v_commands := COALESCE(v_value->'commands', '[]'::jsonb);
  IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'ui_command_registry.commands must be an array';
  END IF;

  SELECT jsonb_agg(
           CASE
             WHEN cmd->>'key' = 'shipments.print_labels' THEN
               jsonb_set(
                 cmd,
                 '{execution,params,workflow_start}',
                 COALESCE(cmd #> '{execution,params,workflow_start}', '{}'::jsonb)
                 || jsonb_build_object(
                      'inline_kick_enabled', true,
                      'inline_kick_max_attempts', 6,
                      'inline_kick_budget_ms', 3500,
                      'inline_kick_poll_ms', 40
                    ),
                 true
               )
             ELSE cmd
           END
         )
  INTO v_updated_commands
  FROM jsonb_array_elements(v_commands) AS cmd;

  UPDATE public.settings_versions
  SET value = jsonb_set(COALESCE(v_value, '{}'::jsonb), '{commands}', COALESCE(v_updated_commands, '[]'::jsonb), true),
      change_reason = 'Increase shipments.print_labels inline workflow budget for single-target print execute completion',
      approved_at = workflow_now(),
      effective_from = workflow_now()
  WHERE id = v_version_id;

  UPDATE public.settings
  SET cached_value = (SELECT value FROM public.settings_versions WHERE id = v_version_id),
      last_updated = workflow_now()
  WHERE id = v_settings_id;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603063320_shipments_print_labels_interactive_budget_v4'));
COMMIT;
