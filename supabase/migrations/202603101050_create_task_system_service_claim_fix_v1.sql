-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S99
-- Purpose:
-- - Ensure create_task_system_v1 propagates a service_role request claim when it
--   invokes create_task_v1 from trusted service/worker contexts.
-- - Preserve the workflow binding review_requested stage path for downstream
--   binding_key/stage_key-driven task creation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603101050_create_task_system_service_claim_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_task_system_v1(
  p_payload JSONB
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID,
  workflow_run_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_input JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;

  v_task_type_key TEXT := NULL;
  v_context JSONB := '{}'::jsonb;
  v_resource_type TEXT := NULL;
  v_resource_id UUID := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_idempotency_key TEXT := NULL;
  v_metadata JSONB := '{}'::jsonb;
  v_actor_system TEXT := NULL;

  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_task_system_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RAISE EXCEPTION 'create_task_system_v1 requires service_role context';
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_input->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    RAISE EXCEPTION 'create_task_system_v1 requires task_type_key' USING ERRCODE = '23514';
  END IF;

  v_context := COALESCE(v_input->'context', '{}'::jsonb);
  v_resource_type := NULLIF(btrim(COALESCE(v_input->>'resource_type', '')), '');
  BEGIN v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(v_input->>'priority', '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  BEGIN v_org_id := NULLIF(v_context->>'organization_id', '')::uuid; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NOT NULL THEN
    PERFORM public.ensure_task_type_from_catalog_v1(v_org_id, v_task_type_key, v_context);
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := v_service_claims || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  BEGIN
    RETURN QUERY
    SELECT *
    FROM public.create_task_v1(
      v_task_type_key,
      v_context,
      v_resource_type,
      v_resource_id,
      v_queue_key,
      v_priority,
      v_sla_minutes,
      v_idempotency_key,
      v_metadata
    );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$$;

SELECT pg_advisory_unlock(hashtext('202603101050_create_task_system_service_claim_fix_v1'));
COMMIT;
