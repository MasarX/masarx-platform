-- Migration: Warehouse transfer checkpoint sequence policy v1
-- Date: 2026-05-23
--
-- General warehouse checkpoint scans still follow the warehouse floor sequence:
-- inbound -> sort -> load -> unload -> return. Transfer linehaul scans are a
-- narrower chain scoped by warehouse_transfer_id and must be able to start at
-- load, then proceed to unload. Keep that behavior row-driven under
-- scan_policy.warehouse_checkpoint.warehouse_transfer_sequence.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230555_warehouse_transfer_checkpoint_sequence_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_checkpoint JSONB := '{}'::jsonb;
  v_next JSONB := NULL;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      sv.id AS settings_version_id,
      COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS current_value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'scan_policy'
      AND sv.category = 'scan_policy'
  LOOP
    v_current := COALESCE(v_row.current_value, '{}'::jsonb);
    IF jsonb_typeof(v_current) <> 'object' THEN
      CONTINUE;
    END IF;

    v_checkpoint := COALESCE(v_current->'warehouse_checkpoint', '{}'::jsonb);
    IF jsonb_typeof(v_checkpoint) <> 'object' THEN
      v_checkpoint := '{}'::jsonb;
    END IF;
    IF v_checkpoint ? 'warehouse_transfer_sequence' THEN
      CONTINUE;
    END IF;

    v_checkpoint := v_checkpoint
      || jsonb_build_object('warehouse_transfer_sequence', jsonb_build_array('load', 'unload'));
    v_next := jsonb_set(v_current, '{warehouse_checkpoint}', v_checkpoint, TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.settings_id;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_def TEXT;
  v_old TEXT := $$FROM jsonb_array_elements_text(COALESCE(v_warehouse_checkpoint_policy->'sequence', '[]'::jsonb)) WITH ORDINALITY AS seq(value, ordinality)$$;
  v_new TEXT := $$FROM jsonb_array_elements_text(
        COALESCE(
          CASE
            WHEN v_transfer_id IS NOT NULL
              THEN COALESCE(
                v_warehouse_checkpoint_policy->'warehouse_transfer_sequence',
                v_warehouse_checkpoint_policy->'transfer_sequence'
              )
            ELSE NULL
          END,
          v_warehouse_checkpoint_policy->'sequence',
          '[]'::jsonb
        )
      ) WITH ORDINALITY AS seq(value, ordinality)$$;
BEGIN
  SELECT pg_get_functiondef('public.record_scan_event_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF position('warehouse_transfer_sequence' IN v_def) > 0 THEN
    RETURN;
  END IF;
  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'record_scan_event_v1 checkpoint sequence lookup shape not found';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$do$;

COMMENT ON FUNCTION public.record_scan_event_v1(JSONB)
  IS 'Record scan events with tenant/device policy enforcement, warehouse checkpoint sequencing, and transfer-specific load/unload sequence support from scan_policy.warehouse_checkpoint.warehouse_transfer_sequence.';

SELECT pg_advisory_unlock(hashtext('202605230555_warehouse_transfer_checkpoint_sequence_policy_v1'));
COMMIT;
