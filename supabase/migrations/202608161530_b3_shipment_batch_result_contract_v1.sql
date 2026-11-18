-- Migration: Declare the shipment batch-item result contract in the UI registry
-- Purpose:
-- - Let shared UI render structured shipment batch results from registry metadata.
-- - Keep result handling independent of RPC names.
-- - Add the discriminator to every existing ui_command_registry scope without
--   replacing or dropping any command metadata.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607181200_shipment_batch_result_contract_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Canonical ui_command_registry schema
-------------------------------------------------------------------------------

DO $schema$
DECLARE
  v_schema_count INTEGER := 0;
BEGIN
  SELECT COUNT(*)::INTEGER
    INTO v_schema_count
    FROM public.schema_registry
   WHERE category = 'ui_command_registry'
     AND is_active = TRUE;

  IF v_schema_count = 0 THEN
    RAISE EXCEPTION 'active ui_command_registry schema is required';
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.schema_registry
     WHERE category = 'ui_command_registry'
       AND is_active = TRUE
       AND jsonb_typeof(schema #> '{properties,commands,items,properties,execution,properties}')
           IS DISTINCT FROM 'object'
  ) THEN
    RAISE EXCEPTION 'active ui_command_registry execution schema properties must be an object';
  END IF;

  UPDATE public.schema_registry
     SET schema = jsonb_set(
           schema,
           '{properties,commands,items,properties,execution,properties,result_contract}',
           jsonb_build_object(
             'type', 'string',
             'enum', jsonb_build_array('batch_items_v1'),
             'description', 'Registry-owned discriminator for the structured action result renderer.'
           ),
           TRUE
         ),
         updated_at = now()
   WHERE category = 'ui_command_registry'
     AND is_active = TRUE
     AND schema #> '{properties,commands,items,properties,execution,properties,result_contract}'
         IS DISTINCT FROM jsonb_build_object(
           'type', 'string',
           'enum', jsonb_build_array('batch_items_v1'),
           'description', 'Registry-owned discriminator for the structured action result renderer.'
         );
END;
$schema$;

-------------------------------------------------------------------------------
-- 2) Additive command update across every persisted scope
-------------------------------------------------------------------------------

DO $commands$
DECLARE
  v_row RECORD;
  v_current JSONB := '{}'::jsonb;
  v_next JSONB := '{}'::jsonb;
  v_commands JSONB := '[]'::jsonb;
  v_updated_commands JSONB := '[]'::jsonb;
  v_command JSONB := '{}'::jsonb;
  v_execution JSONB := '{}'::jsonb;
  v_delete_count INTEGER := 0;
  v_reschedule_count INTEGER := 0;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.scope_type,
      s.scope_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_command_registry'
    ORDER BY s.scope_type, s.scope_id NULLS FIRST, s.id
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      RAISE EXCEPTION 'ui_command_registry scope %/% must be an object',
        v_row.scope_type,
        COALESCE(v_row.scope_id::TEXT, '<global>');
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_command_registry scope %/% commands must be an array',
        v_row.scope_type,
        COALESCE(v_row.scope_id::TEXT, '<global>');
    END IF;

    v_updated_commands := '[]'::jsonb;
    v_delete_count := 0;
    v_reschedule_count := 0;

    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS command(value)
    LOOP
      IF v_command->>'key' IN ('shipments.delete', 'shipments.reschedule') THEN
        IF v_command->>'key' = 'shipments.delete' THEN
          v_delete_count := v_delete_count + 1;
        ELSE
          v_reschedule_count := v_reschedule_count + 1;
        END IF;

        v_execution := COALESCE(v_command->'execution', '{}'::jsonb);
        IF jsonb_typeof(v_execution) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'ui_command_registry command % execution must be an object in scope %/%',
            v_command->>'key',
            v_row.scope_type,
            COALESCE(v_row.scope_id::TEXT, '<global>');
        END IF;

        v_command := jsonb_set(
          v_command,
          '{execution,result_contract}',
          to_jsonb('batch_items_v1'::TEXT),
          TRUE
        );
      END IF;

      v_updated_commands := v_updated_commands || jsonb_build_array(v_command);
    END LOOP;

    IF v_delete_count <> 1 OR v_reschedule_count <> 1 THEN
      RAISE EXCEPTION
        'ui_command_registry scope %/% must contain exactly one shipments.delete and shipments.reschedule command (delete=%, reschedule=%)',
        v_row.scope_type,
        COALESCE(v_row.scope_id::TEXT, '<global>'),
        v_delete_count,
        v_reschedule_count;
    END IF;

    v_next := jsonb_set(v_current, '{commands}', v_updated_commands, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = COALESCE(v_row.version, 0) + 1,
             change_reason = 'Declare batch_items_v1 result contract for shipment cohort actions.',
             approved_at = now(),
             effective_from = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$commands$;

SELECT pg_advisory_unlock(hashtext('202607181200_shipment_batch_result_contract_v1'));

COMMIT;
