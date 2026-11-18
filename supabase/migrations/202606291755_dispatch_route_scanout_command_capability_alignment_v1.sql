-- Migration: Dispatch route scanout command capability alignment v1
-- Purpose:
--   - Keep route scan-out mutation controls aligned with the canonical backend
--     write guards instead of exposing them to route-read-only users.
--   - Preserve route-run scoped, registry-driven execution with no duplicate
--     departure logic.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606291755_dispatch_route_scanout_command_capability_alignment_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        CASE value->>'key'
          WHEN 'routes.scan_load' THEN
            jsonb_set(value, '{capability}', to_jsonb('scan_events.write'::text), TRUE)
          WHEN 'routes.confirm_departure' THEN
            jsonb_set(value, '{capability}', to_jsonb('tasks.complete'::text), TRUE)
          ELSE value
        END
      ),
      '[]'::jsonb
    )
      INTO v_commands
      FROM jsonb_array_elements(v_commands) AS value;

    v_next := jsonb_set(v_current, '{commands}', v_commands, TRUE);
    IF v_next IS NOT DISTINCT FROM v_current THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET value = v_next,
           version = v_row.version + 1,
           change_reason = 'Align route scan-out UI command capabilities with canonical scan/departure mutation guards.',
           approved_at = now(),
           effective_from = now(),
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202606291755_dispatch_route_scanout_command_capability_alignment_v1'));
COMMIT;
