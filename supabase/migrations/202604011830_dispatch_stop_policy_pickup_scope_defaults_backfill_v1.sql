-- Plan: PLAN-202603-fieldops-driver-production-readiness-v1 / Step: S05
-- Migration: Dispatch stop policy pickup scope defaults backfill v1
-- Date: 2026-04-01
--
-- Goals:
--   - Repair scoped dispatch_stop_policy rows that override stop_kind_map.pickup without carrying the
--     pickup exception outcome_map introduced by pickup batch 2.
--   - Preserve existing scoped overrides and fill only missing pickup outcome defaults.
--   - Keep FieldOps/Console/Portal pickup exception handling aligned with the canonical policy ladder.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604011830_dispatch_stop_policy_pickup_scope_defaults_backfill_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_stop_kind_map JSONB := '{}'::jsonb;
  v_pickup JSONB := '{}'::jsonb;
  v_outcome_map JSONB := '{}'::jsonb;
  v_next JSONB := NULL;
  v_additions JSONB := jsonb_build_object(
    'no_answer', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'phone_unreachable', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'business_closed', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'sender_unavailable', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'pickup_not_ready', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'address_not_found', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'address_incorrect', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'payment_issue', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'package_damaged', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'package_lost', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'customer_refused', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'access_restricted', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'quantity_mismatch', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    ),
    'other', jsonb_build_object(
      'shipment_status', 'pickup_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_pickup_escalation_review', 'resource_id_source', 'shipment')
      )
    )
  );
  v_key TEXT;
  v_value JSONB;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS current_value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'dispatch_stop_policy'
      AND s.scope_type IN ('tenant', 'client', 'sender', 'resource')
      AND sv.category = 'dispatch_stop_policy'
  LOOP
    v_current := COALESCE(v_row.current_value, '{}'::jsonb);
    IF jsonb_typeof(v_current) <> 'object' THEN
      CONTINUE;
    END IF;

    v_stop_kind_map := COALESCE(v_current->'stop_kind_map', '{}'::jsonb);
    IF jsonb_typeof(v_stop_kind_map) <> 'object' THEN
      CONTINUE;
    END IF;

    v_pickup := COALESCE(v_stop_kind_map->'pickup', '{}'::jsonb);
    IF jsonb_typeof(v_pickup) <> 'object' THEN
      CONTINUE;
    END IF;

    v_outcome_map := COALESCE(v_pickup->'outcome_map', '{}'::jsonb);
    IF jsonb_typeof(v_outcome_map) <> 'object' THEN
      v_outcome_map := '{}'::jsonb;
    END IF;

    FOR v_key, v_value IN
      SELECT key, value
      FROM jsonb_each(v_additions)
    LOOP
      IF NOT (v_outcome_map ? v_key) THEN
        v_outcome_map := jsonb_set(v_outcome_map, ARRAY[v_key], v_value, TRUE);
      END IF;
    END LOOP;

    v_next := jsonb_set(v_pickup, '{outcome_map}', v_outcome_map, TRUE);
    IF v_next IS NOT DISTINCT FROM v_pickup THEN
      CONTINUE;
    END IF;

    v_stop_kind_map := jsonb_set(v_stop_kind_map, '{pickup}', v_next, TRUE);
    v_next := jsonb_set(v_current, '{stop_kind_map}', v_stop_kind_map, TRUE);

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

SELECT pg_advisory_unlock(hashtext('202604011830_dispatch_stop_policy_pickup_scope_defaults_backfill_v1'));
COMMIT;
