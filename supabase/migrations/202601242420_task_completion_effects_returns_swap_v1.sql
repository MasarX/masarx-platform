-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Task completion effects policy: add return/swap task mappings (non-stomping)
-- Date: 2026-01-24
--
-- Why:
--   - dispatch_return_pickup and dispatch_swap_completion exist in task_type_catalog but were not wired into
--     task_completion_effects_policy or domain_event_policy, so completion did not drive shipment effects.
--   - Keep it row-driven: behavior lives in settings rows (ladder-resolved), not code branches.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242420_task_completion_effects_returns_swap_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Expand task_completion_effects_policy global default (additive; does not overwrite existing keys)
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_next JSONB := '{}'::jsonb;

  v_existing_map JSONB := NULL;
  v_map JSONB := '{}'::jsonb;
  v_additions JSONB := jsonb_build_object(
    'dispatch_return_pickup', jsonb_build_object('shipment_status', 'return_to_origin'),
    'dispatch_swap_completion', jsonb_build_object('shipment_status', 'delivered')
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
    RETURN;
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
    'Expand task_completion_effects_policy with dispatch return/swap task effects',
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
-- 2) Wire domain_event_policy for task.completed.dispatch_return_pickup + dispatch_swap_completion (non-stomping)
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
    RAISE EXCEPTION 'task_completion_effects_v1 template missing';
  END IF;

  SELECT s.cached_value
    INTO v_current
    FROM public.settings s
   WHERE s.category = 'domain_event_policy'
     AND s.scope_type = 'global'
     AND s.scope_hash = v_scope_hash
   LIMIT 1;

  IF v_current IS NULL OR jsonb_typeof(v_current) <> 'object' THEN
    RETURN;
  END IF;

  v_next := v_current;
  v_has_events := (v_next ? 'events') AND jsonb_typeof(v_next->'events') = 'object';

  FOREACH v_event_key IN ARRAY ARRAY[
    'task.completed.dispatch_return_pickup',
    'task.completed.dispatch_swap_completion'
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
    'Wire task.completed.dispatch_return_pickup + dispatch_swap_completion to task_completion_effects_v1',
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

SELECT pg_advisory_unlock(hashtext('202601242420_task_completion_effects_returns_swap_v1'));
COMMIT;

