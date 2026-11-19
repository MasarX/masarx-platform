-- Migration: Dispatch route scanout scan-event readback schema v1
-- Purpose:
--   - Expose canonical scan-event lineage returned by route-load scan-out
--     through the UI command registry readback schema.
--   - Keep the route-run scoped executor and reconciliation path unchanged.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606302005_dispatch_route_scanout_scan_event_readback_schema_v1'));
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
            jsonb_set(
              value,
              '{execution,readback_schema,fields}',
              (
                SELECT COALESCE(jsonb_agg(field), '[]'::jsonb)
                FROM jsonb_array_elements(COALESCE(value #> '{execution,readback_schema,fields}', '[]'::jsonb)) AS field
                WHERE field->>'key' NOT IN ('scan_event_id', 'scan_created')
              ) || jsonb_build_array(
                jsonb_build_object(
                  'key', 'scan_event_id',
                  'label', 'Scan event',
                  'path', 'scan_event_id'
                ),
                jsonb_build_object(
                  'key', 'scan_created',
                  'label', 'Scan recorded',
                  'path', 'scan_created'
                )
              ),
              TRUE
            )
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
           change_reason = 'Expose route-load scan event lineage in route scan-out readback schema.',
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

SELECT pg_advisory_unlock(hashtext('202606302005_dispatch_route_scanout_scan_event_readback_schema_v1'));
COMMIT;
