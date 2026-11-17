-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: Warehouse task catalog + task completion effects wiring v1
-- Date: 2026-01-30
--
-- Goals:
--   - Add core warehouse operational task types (receive/sort/stage/load/exception_hold) as row-driven catalog defaults.
--   - Wire task completion -> domain events -> workflow engine -> shipment actions using existing generic pipeline:
--       task_events (completed) -> domain_events (task.completed.<task_type_key>) -> task_completion_effects_v1
--   - Zero hardcoding: behavior lives in settings rows (task_type_catalog, task_completion_effects_policy, domain_event_policy).
--   - Versioned settings updates (close out + insert new version) for auditability.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300010_warehouse_task_catalog_effects_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) task_type_catalog: add warehouse task types (global default; additive)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_types JSONB := '[]'::jsonb;
  v_prev_task_types JSONB := '[]'::jsonb;

  v_desired JSONB := jsonb_build_array(
    jsonb_build_object('key', 'warehouse_receive', 'name', 'Warehouse Receive', 'description', 'Receive inbound shipments/units into the branch/warehouse.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_sort', 'name', 'Warehouse Sort', 'description', 'Sort shipments/units into routes/areas for downstream processing.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_stage', 'name', 'Warehouse Stage', 'description', 'Stage shipments/units for loading or dispatch handoff.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_load_vehicle', 'name', 'Warehouse Load Vehicle', 'description', 'Load shipments/units onto an assigned vehicle/route run.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE),
    jsonb_build_object('key', 'warehouse_exception_hold', 'name', 'Warehouse Exception Hold', 'description', 'Hold shipment pending investigation or corrective action.', 'default_priority', 50, 'default_queue_key', 'warehouse', 'enabled', TRUE)
  );

  v_item JSONB;
  v_key TEXT;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_type_catalog'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    RAISE EXCEPTION 'warehouse_task_catalog_effects_v1: global task_type_catalog settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_task_types := COALESCE(v_existing->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;
  v_prev_task_types := v_task_types;

  FOR v_item IN
    SELECT value FROM jsonb_array_elements(v_desired)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_task_types) e
      WHERE lower(NULLIF(btrim(COALESCE(e->>'key', '')), '')) = v_key
    ) THEN
      v_task_types := v_task_types || jsonb_build_array(v_item);
    END IF;
  END LOOP;

  IF v_task_types IS NOT DISTINCT FROM v_prev_task_types THEN
    RETURN;
  END IF;

  v_policy := v_existing;
  v_policy := jsonb_set(v_policy, '{task_types}', v_task_types, TRUE);

  -- Close out any existing approved "current" row so the partial unique index remains valid.
  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_type_catalog'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add warehouse operational task types to task_type_catalog',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'task_type_catalog',
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

-------------------------------------------------------------------------------
-- 2) task_completion_effects_policy: add warehouse effects (global default; additive)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_next JSONB := '{}'::jsonb;

  v_existing_map JSONB := NULL;
  v_map JSONB := '{}'::jsonb;
  v_additions JSONB := jsonb_build_object(
    -- Major milestones:
    'warehouse_receive', jsonb_build_object('shipment_status', 'pending_dispatch', 'action_type', 'scan', 'action_category', 'operational'),
    'warehouse_load_vehicle', jsonb_build_object('shipment_status', 'out_for_delivery', 'action_type', 'status_change', 'action_category', 'operational'),
    -- Operational steps (no status projection change; tasks remain the SSOT for step-level state):
    'warehouse_sort', jsonb_build_object('action_type', 'scan', 'action_category', 'operational'),
    'warehouse_stage', jsonb_build_object('action_type', 'scan', 'action_category', 'operational'),
    'warehouse_exception_hold', jsonb_build_object('action_type', 'exception', 'action_category', 'exception')
  );

  v_k TEXT;
  v_v JSONB;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
BEGIN
  SELECT s.cached_value
    INTO v_existing
    FROM public.settings s
   WHERE s.category = 'task_completion_effects_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_existing IS NULL OR jsonb_typeof(v_existing) <> 'object' THEN
    RAISE EXCEPTION 'warehouse_task_catalog_effects_v1: global task_completion_effects_policy settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_next := v_existing;

  v_existing_map := v_next->'task_type_map';
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

  v_next := jsonb_set(v_next, '{task_type_map}', v_map, TRUE);

  -- Close out any existing approved "current" row so the partial unique index remains valid.
  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'task_completion_effects_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'task_completion_effects_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'task_completion_effects_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_next,
    1,
    'Expand task_completion_effects_policy with warehouse operational task effects',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'task_completion_effects_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_next,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

-------------------------------------------------------------------------------
-- 3) domain_event_policy: wire task.completed.warehouse_* -> task_completion_effects_v1 (global default; additive)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_template_id UUID;
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_current JSONB := NULL;
  v_next JSONB := '{}'::jsonb;
  v_sv_id UUID := gen_random_uuid();
  v_next_version INT := 1;
  v_updated BOOLEAN := FALSE;

  v_has_events BOOLEAN := FALSE;
  v_event_key TEXT;
  v_existing_event JSONB;
  v_path TEXT[];
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'task_completion_effects_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'warehouse_task_catalog_effects_v1: task_completion_effects_v1 template missing'
      USING ERRCODE = '23503';
  END IF;

  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'domain_event_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RAISE EXCEPTION 'warehouse_task_catalog_effects_v1: global domain_event_policy settings missing'
      USING ERRCODE = '23503';
  END IF;

  v_next := v_current;
  v_has_events := (v_next ? 'events') AND jsonb_typeof(v_next->'events') = 'object';

  FOREACH v_event_key IN ARRAY ARRAY[
    'task.completed.warehouse_receive',
    'task.completed.warehouse_sort',
    'task.completed.warehouse_stage',
    'task.completed.warehouse_load_vehicle',
    'task.completed.warehouse_exception_hold'
  ]
  LOOP
    IF v_has_events THEN
      v_path := ARRAY['events', v_event_key];
    ELSE
      v_path := ARRAY[v_event_key];
    END IF;

    v_existing_event := COALESCE(v_next #> v_path, '{}'::jsonb);
    IF jsonb_typeof(v_existing_event) IS DISTINCT FROM 'object' THEN
      v_existing_event := '{}'::jsonb;
    END IF;

    IF COALESCE(v_existing_event->>'workflow_template_id', '') = '' THEN
      v_next := jsonb_set(
        v_next,
        v_path,
        public.jsonb_deep_merge(
          v_existing_event,
          jsonb_build_object('workflow_template_id', v_template_id::text)
        ),
        TRUE
      );
      v_updated := TRUE;
    END IF;
  END LOOP;

  IF NOT v_updated THEN
    RETURN;
  END IF;

  -- Close out any existing approved "current" row so the partial unique index remains valid.
  UPDATE public.settings_versions
     SET effective_until = workflow_now()
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'domain_event_policy'
     AND scope_type = 'global'
     AND scope_hash = v_scope_hash;

  INSERT INTO public.settings_versions (
    id, category, scope_type, scope_id, scope_hash, version,
    value, schema_version, change_reason, approved_at, effective_from
  ) VALUES (
    v_sv_id,
    'domain_event_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_next,
    1,
    'Wire task.completed.warehouse_* to task_completion_effects_v1',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category, scope_type, scope_id, scope_hash,
    settings_version_id, cached_value, last_updated
  )
  VALUES (
    'domain_event_policy',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_sv_id,
    v_next,
    workflow_now()
  )
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
  SET settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601300010_warehouse_task_catalog_effects_v1'));
COMMIT;

