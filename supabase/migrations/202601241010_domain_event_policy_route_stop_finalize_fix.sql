-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix domain_event_policy mapping for task.completed.route_stop_execute (jsonb_set intermediate object)
-- Date: 2026-01-24
--
-- Note:
--   Postgres jsonb_set does not create missing intermediate objects for deep paths.
--   Store per-event policy as an object at events[<event_type>] (not events[...].workflow_template_id).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601241010_domain_event_policy_route_stop_finalize_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_template_id UUID;
  v_current JSONB;
  v_next JSONB;
  v_sv_id UUID;
BEGIN
  SELECT id INTO v_template_id
  FROM public.workflow_templates
  WHERE name = 'dispatch_route_stop_finalize_v1'
  LIMIT 1;

  IF v_template_id IS NULL THEN
    RAISE EXCEPTION 'dispatch_route_stop_finalize_v1 template missing';
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

  v_next := jsonb_set(
    v_current,
    ARRAY['events','task.completed.route_stop_execute'],
    jsonb_strip_nulls(jsonb_build_object('workflow_template_id', v_template_id::text)),
    TRUE
  );

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
      'Fix mapping: task.completed.route_stop_execute -> dispatch_route_stop_finalize_v1',
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

SELECT pg_advisory_unlock(hashtext('202601241010_domain_event_policy_route_stop_finalize_fix'));
COMMIT;

