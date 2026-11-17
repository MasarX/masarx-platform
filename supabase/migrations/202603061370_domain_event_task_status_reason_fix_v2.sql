-- Plan: PLAN-202603-landing-public-tracking-page / Step: S04
-- Migration: Domain event task status_reason propagation fix v2
-- Date: 2026-03-06
--
-- Purpose:
--   - Correct v1 by sourcing status_reason from task_events.payload.
--   - Keep task completion domain events self-contained for workflow handlers.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603061370_domain_event_task_status_reason_fix_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.domain_event_from_task_event_completed_v1()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_task RECORD;
  v_task_type_key TEXT;
  v_event_type TEXT;
  v_policy JSONB;
  v_template_id UUID := NULL;
  v_payload JSONB;
  v_corr UUID := NULL;
  v_resource_type TEXT;
  v_resource_id UUID;
  v_task_event_payload JSONB := COALESCE(NEW.payload, '{}'::jsonb);
  v_status_reason TEXT := NULLIF(btrim(COALESCE(COALESCE(NEW.payload, '{}'::jsonb)->>'status_reason', '')), '');
BEGIN
  IF NEW.event_type IS DISTINCT FROM 'status_changed' THEN
    RETURN NEW;
  END IF;
  IF NEW.to_status IS DISTINCT FROM 'completed' THEN
    RETURN NEW;
  END IF;

  SELECT
    t.id,
    t.organization_id,
    t.client_id,
    t.sender_id,
    t.task_type_id,
    t.resource_type,
    t.resource_id
  INTO v_task
  FROM public.tasks t
  WHERE t.id = NEW.task_id
  LIMIT 1;

  IF v_task.organization_id IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT tt.key
    INTO v_task_type_key
    FROM public.task_types tt
   WHERE tt.id = v_task.task_type_id
   LIMIT 1;

  v_task_type_key := lower(COALESCE(NULLIF(btrim(COALESCE(v_task_type_key, '')), ''), 'unknown'));
  v_event_type := format('task.completed.%s', v_task_type_key);

  v_policy := public.resolve_domain_event_policy(v_task.organization_id, v_event_type);
  BEGIN v_template_id := NULLIF(v_policy->>'workflow_template_id', '')::uuid; EXCEPTION WHEN others THEN v_template_id := NULL; END;
  IF v_template_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_resource_type := lower(COALESCE(NULLIF(btrim(COALESCE(v_task.resource_type, '')), ''), 'task'));
  v_resource_id := COALESCE(v_task.resource_id, v_task.id);

  BEGIN v_corr := NULLIF(COALESCE(NEW.payload->>'correlation_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_corr := NULL; END;

  IF v_status_reason IS NOT NULL AND NOT (v_task_event_payload ? 'status_reason') THEN
    v_task_event_payload := v_task_event_payload || jsonb_build_object('status_reason', v_status_reason);
  END IF;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'task_event_id', NEW.id,
    'task_id', v_task.id,
    'task_type_key', v_task_type_key,
    'resource_type', v_task.resource_type,
    'resource_id', v_task.resource_id,
    'actor_user_id', NEW.actor_user_id,
    'actor_system', NEW.actor_system,
    'status_reason', v_status_reason,
    'task_event_payload', v_task_event_payload,
    'task_event_created_at', NEW.created_at,
    'organization_id', v_task.organization_id,
    'client_id', v_task.client_id,
    'sender_id', v_task.sender_id
  ));

  PERFORM public.enqueue_domain_event(
    p_organization_id := v_task.organization_id,
    p_event_type := v_event_type,
    p_resource_type := v_resource_type,
    p_resource_id := v_resource_id,
    p_payload := v_payload,
    p_correlation_id := v_corr
  );

  RETURN NEW;
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603061370_domain_event_task_status_reason_fix_v2'));
COMMIT;
