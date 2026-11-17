-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix domain_event_policy mapping for task.completed.dispatch_* follow-up tasks
-- Date: 2026-01-24
--
-- Note:
--   Postgres jsonb_set does not create missing intermediate objects for deep paths.
--   Store per-event policy as an object at events[<event_type>] (not events[...].workflow_template_id).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601242340_domain_event_policy_task_completion_effects_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_template_id UUID;
  v_current JSONB;
  v_next JSONB;
  v_sv_id UUID;
  v_updated BOOLEAN := FALSE;

  v_event_key TEXT;
  v_existing_event JSONB;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'task_completion_effects_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'task_completion_effects_v1 template missing';
  END IF;

  SELECT sv.id, sv.value
    INTO v_sv_id, v_current
    FROM public.settings_versions sv
   WHERE sv.category = 'domain_event_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
   ORDER BY sv.approved_at DESC NULLS LAST
   LIMIT 1;

  v_current := COALESCE(v_current, '{"events":{}}'::jsonb);
  IF jsonb_typeof(v_current) <> 'object' THEN
    v_current := '{"events":{}}'::jsonb;
  END IF;

  IF NOT (v_current ? 'events') OR jsonb_typeof(v_current->'events') <> 'object' THEN
    v_current := jsonb_set(v_current, '{events}', '{}'::jsonb, TRUE);
  END IF;

  v_next := v_current;

  FOREACH v_event_key IN ARRAY ARRAY[
    'task.completed.dispatch_reschedule_delivery',
    'task.completed.dispatch_reattempt_delivery',
    'task.completed.dispatch_rto_pickup'
  ]
  LOOP
    v_existing_event := COALESCE(v_next #> ARRAY['events', v_event_key], '{}'::jsonb);
    IF jsonb_typeof(v_existing_event) IS DISTINCT FROM 'object' THEN
      v_existing_event := '{}'::jsonb;
    END IF;

    IF COALESCE(v_existing_event->>'workflow_template_id', '') = '' THEN
      v_next := jsonb_set(
        v_next,
        ARRAY['events', v_event_key],
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

  IF v_sv_id IS NULL THEN
    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    )
    VALUES (
      'domain_event_policy',
      'global',
      NULL::uuid,
      1,
      v_next,
      1,
      'Fix mapping: task.completed.dispatch_* -> task_completion_effects_v1',
      now(),
      now()
    )
    RETURNING id INTO v_sv_id;
  ELSE
    UPDATE public.settings_versions
    SET value = v_next,
        approved_at = now()
    WHERE id = v_sv_id;
  END IF;

  UPDATE public.settings s
  SET settings_version_id = v_sv_id,
      cached_value = v_next,
      last_updated = now()
  WHERE s.category = 'domain_event_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202601242340_domain_event_policy_task_completion_effects_fix'));
COMMIT;
