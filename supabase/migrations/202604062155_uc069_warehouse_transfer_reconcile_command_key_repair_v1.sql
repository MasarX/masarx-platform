-- Plan: PLAN-202604-b05-transfer-execution-surface / Step: S04
-- Migration: UC069 warehouse transfer reconcile command key repair v1
-- Date: 2026-04-06
--
-- Goals:
--   - Replace the legacy warehouse_transfers.reconcile command key with the
--     final warehouse_transfers.reconcile_destination key across scoped rows.
--   - Preserve the canonical workflow RPC/input schema contract for fresh and
--     previously-applied local databases.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604062155_uc069_warehouse_transfer_reconcile_command_key_repair_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_canonical_commands JSONB := '{}'::jsonb;
  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next_commands JSONB := '[]'::jsonb;
  v_command JSONB := NULL;
  v_command_key TEXT := NULL;
  v_reconcile_command JSONB := NULL;
BEGIN
  v_canonical_commands := jsonb_set(
    v_canonical_commands,
    ARRAY['warehouse_transfers.reconcile_destination'],
    jsonb_build_object(
      'key', 'warehouse_transfers.reconcile_destination',
      'label', 'Reconcile transfer',
      'description', 'Record the destination reconciliation counts for the selected received transfer and wake the canonical discrepancy workflow.',
      'capability', 'warehouse_transfers.write',
      'schema_category', 'resource:warehouse_transfers',
      'selection', jsonb_build_object('mode', 'single', 'min_count', 1, 'max_count', 1),
      'execution', jsonb_build_object(
        'type', 'workflow',
        'rpc', 'ui_execute_warehouse_transfer_reconcile_v1',
        'params', '{}'::jsonb,
        'input_schema', jsonb_build_object(
          'version', 1,
          'title', 'Destination reconciliation',
          'fields', jsonb_build_array(
            jsonb_build_object(
              'key', 'received_shipment_count',
              'label', 'Received shipment count',
              'type', 'text',
              'required', TRUE
            ),
            jsonb_build_object(
              'key', 'damaged_shipment_count',
              'label', 'Damaged shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'missing_shipment_count',
              'label', 'Missing shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'unmanifested_shipment_count',
              'label', 'Unmanifested shipment count',
              'type', 'text',
              'required', FALSE
            ),
            jsonb_build_object(
              'key', 'reconcile_notes',
              'label', 'Reconcile notes',
              'type', 'textarea',
              'required', FALSE
            )
          )
        ),
        'confirm', jsonb_build_object(
          'title', 'Record transfer reconciliation?',
          'description', 'This completes the active reconcile task for the selected received transfer and advances the canonical discrepancy workflow.',
          'confirm_label', 'Record reconciliation',
          'cancel_label', 'Cancel',
          'tone', 'default'
        )
      )
    ),
    TRUE
  );

  FOR v_row IN
    SELECT
      s.id AS settings_id,
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
      v_commands := '[]'::jsonb;
    END IF;

    v_next_commands := '[]'::jsonb;
    FOR v_command IN
      SELECT value
      FROM jsonb_array_elements(v_commands) AS value
    LOOP
      v_command_key := NULLIF(btrim(COALESCE(v_command->>'key', '')), '');

      IF v_command_key IN ('warehouse_transfers.reconcile', 'warehouse_transfers.reconcile_destination') THEN
        IF v_reconcile_command IS NULL THEN
          v_reconcile_command := public.deep_merge_jsonb(v_canonical_commands->'warehouse_transfers.reconcile_destination', v_command);
          v_reconcile_command := jsonb_set(v_reconcile_command, '{key}', '"warehouse_transfers.reconcile_destination"', TRUE);
          v_reconcile_command := jsonb_set(v_reconcile_command, '{execution,type}', '"workflow"', TRUE);
        END IF;
        CONTINUE;
      END IF;

      v_next_commands := v_next_commands || jsonb_build_array(v_command);
    END LOOP;

    IF v_reconcile_command IS NULL THEN
      v_reconcile_command := v_canonical_commands->'warehouse_transfers.reconcile_destination';
    END IF;

    v_next_commands := v_next_commands || jsonb_build_array(v_reconcile_command);

    v_next := jsonb_set(v_current, ARRAY['commands'], v_next_commands, TRUE);
    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Repair warehouse_transfers.reconcile_destination command key and sync the canonical input schema.',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604062155_uc069_warehouse_transfer_reconcile_command_key_repair_v1'));
COMMIT;
