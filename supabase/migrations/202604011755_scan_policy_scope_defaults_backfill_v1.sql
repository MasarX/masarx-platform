-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S04
-- Migration: Scan policy scoped defaults backfill v1
-- Date: 2026-04-01
--
-- Goals:
--   - Repair active scoped scan_policy rows that predate warehouse checkpoint/correction defaults.
--   - Fill only missing keys so existing scoped overrides remain authoritative.
--   - Keep accepted scan types and nested warehouse/correction/bulk policy objects aligned.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604011755_scan_policy_scope_defaults_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_accepted JSONB := '[]'::jsonb;
  v_warehouse_checkpoint JSONB := '{}'::jsonb;
  v_correction JSONB := '{}'::jsonb;
  v_bulk JSONB := '{}'::jsonb;
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

    v_accepted := COALESCE(v_current->'accepted_scan_types', '[]'::jsonb);
    IF jsonb_typeof(v_accepted) <> 'array' THEN
      v_accepted := '[]'::jsonb;
    END IF;
    IF NOT (v_accepted ? 'warehouse_checkpoint') THEN
      v_accepted := v_accepted || jsonb_build_array('warehouse_checkpoint');
    END IF;
    IF NOT (v_accepted ? 'correction') THEN
      v_accepted := v_accepted || jsonb_build_array('correction');
    END IF;

    v_warehouse_checkpoint := COALESCE(v_current->'warehouse_checkpoint', '{}'::jsonb);
    IF jsonb_typeof(v_warehouse_checkpoint) <> 'object' THEN
      v_warehouse_checkpoint := '{}'::jsonb;
    END IF;
    v_warehouse_checkpoint :=
      v_warehouse_checkpoint
      || CASE WHEN v_warehouse_checkpoint ? 'enabled' THEN '{}'::jsonb ELSE jsonb_build_object('enabled', TRUE) END
      || CASE
           WHEN v_warehouse_checkpoint ? 'sequence' THEN '{}'::jsonb
           ELSE jsonb_build_object('sequence', jsonb_build_array('inbound','sort','load','unload','return'))
         END
      || CASE
           WHEN v_warehouse_checkpoint ? 'require_sequential_progression' THEN '{}'::jsonb
           ELSE jsonb_build_object('require_sequential_progression', TRUE)
         END
      || CASE
           WHEN v_warehouse_checkpoint ? 'allow_bulk' THEN '{}'::jsonb
           ELSE jsonb_build_object('allow_bulk', TRUE)
         END;

    v_correction := COALESCE(v_current->'correction', '{}'::jsonb);
    IF jsonb_typeof(v_correction) <> 'object' THEN
      v_correction := '{}'::jsonb;
    END IF;
    v_correction :=
      v_correction
      || CASE WHEN v_correction ? 'enabled' THEN '{}'::jsonb ELSE jsonb_build_object('enabled', TRUE) END
      || CASE
           WHEN v_correction ? 'require_supervisor_approval' THEN '{}'::jsonb
           ELSE jsonb_build_object('require_supervisor_approval', TRUE)
         END
      || CASE
           WHEN v_correction ? 'approval_task_type_key' THEN '{}'::jsonb
           ELSE jsonb_build_object('approval_task_type_key', 'warehouse_scan_supervisor_approval')
         END;

    v_bulk := COALESCE(v_current->'bulk', '{}'::jsonb);
    IF jsonb_typeof(v_bulk) <> 'object' THEN
      v_bulk := '{}'::jsonb;
    END IF;
    v_bulk :=
      v_bulk
      || CASE WHEN v_bulk ? 'enabled' THEN '{}'::jsonb ELSE jsonb_build_object('enabled', TRUE) END
      || CASE WHEN v_bulk ? 'max_items' THEN '{}'::jsonb ELSE jsonb_build_object('max_items', 50) END;

    v_next := jsonb_set(v_current, '{accepted_scan_types}', v_accepted, TRUE);
    v_next := jsonb_set(v_next, '{warehouse_checkpoint}', v_warehouse_checkpoint, TRUE);
    v_next := jsonb_set(v_next, '{correction}', v_correction, TRUE);
    v_next := jsonb_set(v_next, '{bulk}', v_bulk, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
      SET
        value = v_next,
        updated_at = now()
      WHERE id = v_row.settings_version_id;

      UPDATE public.settings
      SET
        cached_value = v_next,
        last_updated = now()
      WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604011755_scan_policy_scope_defaults_backfill_v1'));
COMMIT;
