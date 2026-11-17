-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Expand dispatch_stop_policy delivery outcome_map with canonical reasons + task follow-ups (non-stomping)
-- Date: 2026-01-24
--
-- Why:
--   - dispatch_stop_policy already supports outcome_reason -> shipment transition + follow-up tasks.
--   - We now have a canonical reason catalog + standard dispatch exception task types.
--   - This migration expands the global default mapping additively (does not overwrite existing keys).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242130_dispatch_stop_policy_outcome_expansion_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing_policy JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;

  v_existing_map JSONB := NULL;
  v_map JSONB := '{}'::jsonb;
  v_additions JSONB := jsonb_build_object(
    'customer_refused', jsonb_build_object(
      'shipment_status', 'return_to_origin',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_rto_pickup', 'resource_id_source', 'shipment')
      )
    ),
    'address_not_found', jsonb_build_object(
      'shipment_status', 'delivery_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_delivery', 'resource_id_source', 'shipment')
      )
    ),
    'address_incorrect', jsonb_build_object(
      'shipment_status', 'delivery_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reschedule_delivery', 'resource_id_source', 'shipment')
      )
    ),
    'business_closed', jsonb_build_object(
      'shipment_status', 'delivery_failed',
      'action_type', 'exception',
      'action_category', 'exception',
      'followup_tasks', jsonb_build_array(
        jsonb_build_object('task_type_key', 'dispatch_reattempt_delivery', 'resource_id_source', 'shipment')
      )
    )
  );

  v_k TEXT;
  v_v JSONB;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing_policy
    FROM public.settings s
   WHERE s.category = 'dispatch_stop_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing_policy IS NULL OR jsonb_typeof(v_existing_policy) <> 'object' THEN
    v_existing_policy := '{}'::jsonb;
  END IF;

  v_policy := v_existing_policy;

  -- Ensure base structure exists (keep existing values where present).
  IF jsonb_typeof(v_policy->'stop_kind_map') <> 'object' THEN
    v_policy := jsonb_set(v_policy, '{stop_kind_map}', '{}'::jsonb, TRUE);
  END IF;
  IF jsonb_typeof(v_policy #> '{stop_kind_map,delivery}') <> 'object' THEN
    v_policy := jsonb_set(v_policy, '{stop_kind_map,delivery}', '{}'::jsonb, TRUE);
  END IF;

  v_existing_map := v_policy #> '{stop_kind_map,delivery,outcome_map}';
  v_map := COALESCE(v_existing_map, '{}'::jsonb);
  IF jsonb_typeof(v_map) <> 'object' THEN
    v_map := '{}'::jsonb;
  END IF;

  FOR v_k, v_v IN
    SELECT key, value FROM jsonb_each(v_additions)
  LOOP
    IF NOT (v_map ? v_k) THEN
      v_map := jsonb_set(v_map, ARRAY[v_k], v_v, TRUE);
    END IF;
  END LOOP;

  IF v_existing_map IS NOT DISTINCT FROM v_map THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_policy, '{stop_kind_map,delivery,outcome_map}', v_map, TRUE);

  -- Close out any existing approved "current" row so the partial unique index remains valid.
  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'dispatch_stop_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'dispatch_stop_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'dispatch_stop_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Expand dispatch_stop_policy delivery outcome_map with canonical reasons + follow-up tasks',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'dispatch_stop_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_policy,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242130_dispatch_stop_policy_outcome_expansion_v1'));
COMMIT;

