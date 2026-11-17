-- Plan: PLAN-202604-b09-ndr-owner-sla / Step: S04
-- Migration: Task assignment defaults and NDR follow-up ownership
-- Date: 2026-04-03
--
-- Why:
--   - Failed delivery/NDR follow-up tasks need a canonical row-driven owner + SLA contract.
--   - Queue/SLA/owner defaults must live on task type rows and catalog settings, not in workflow handlers.
--   - Dispatch stop finalization should only create canonical follow-up tasks, then assign them through a service-only task RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604032100_task_assignment_defaults_and_ndr_followups_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Global task_type_catalog: dispatch follow-up assignment defaults
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_scope_hash UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_existing JSONB := NULL;
  v_policy JSONB := '{}'::jsonb;
  v_task_types JSONB := '[]'::jsonb;
  v_prev_task_types JSONB := '[]'::jsonb;
  v_updated_task_types JSONB := '[]'::jsonb;
  v_desired JSONB := jsonb_build_array(
    jsonb_build_object(
      'key', 'dispatch_exception_review',
      'name', 'Dispatch Exception Review',
      'default_priority', 50,
      'default_queue_key', 'dispatch',
      'enabled', TRUE,
      'metadata', jsonb_build_object(
        'assignment_defaults',
        jsonb_build_object(
          'queue_key', 'dispatch',
          'sla_minutes', 60,
          'assigned_to_user_type', 'ops_admin'
        )
      )
    ),
    jsonb_build_object(
      'key', 'dispatch_reschedule_delivery',
      'name', 'Dispatch Reschedule Delivery',
      'default_priority', 50,
      'default_queue_key', 'dispatch',
      'enabled', TRUE,
      'metadata', jsonb_build_object(
        'assignment_defaults',
        jsonb_build_object(
          'queue_key', 'dispatch',
          'sla_minutes', 60,
          'assigned_to_user_type', 'ops_admin'
        )
      )
    ),
    jsonb_build_object(
      'key', 'dispatch_reattempt_delivery',
      'name', 'Dispatch Reattempt Delivery',
      'default_priority', 50,
      'default_queue_key', 'dispatch',
      'enabled', TRUE,
      'metadata', jsonb_build_object(
        'assignment_defaults',
        jsonb_build_object(
          'queue_key', 'dispatch',
          'sla_minutes', 60,
          'assigned_to_user_type', 'ops_admin'
        )
      )
    ),
    jsonb_build_object(
      'key', 'dispatch_rto_pickup',
      'name', 'Dispatch RTO Pickup',
      'default_priority', 50,
      'default_queue_key', 'dispatch',
      'enabled', TRUE,
      'metadata', jsonb_build_object(
        'assignment_defaults',
        jsonb_build_object(
          'queue_key', 'dispatch',
          'sla_minutes', 60,
          'assigned_to_user_type', 'ops_admin'
        )
      )
    )
  );
  v_item JSONB;
  v_desired_item JSONB;
  v_key TEXT;
  v_item_metadata JSONB;
  v_assignment_defaults JSONB;
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
    RAISE EXCEPTION 'task_assignment_defaults_and_ndr_followups_v1: global task_type_catalog settings missing'
      USING ERRCODE = '23514';
  END IF;

  v_task_types := COALESCE(v_existing->'task_types', '[]'::jsonb);
  IF jsonb_typeof(v_task_types) <> 'array' THEN
    v_task_types := '[]'::jsonb;
  END IF;
  v_prev_task_types := v_task_types;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_task_types)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_item->>'key', '')), ''));
    v_desired_item := NULL;

    IF v_key IS NOT NULL THEN
      SELECT desired.value
        INTO v_desired_item
        FROM jsonb_array_elements(v_desired) AS desired(value)
       WHERE lower(NULLIF(btrim(COALESCE(desired.value->>'key', '')), '')) = v_key
       LIMIT 1;
    END IF;

    IF v_desired_item IS NULL THEN
      v_updated_task_types := v_updated_task_types || jsonb_build_array(v_item);
      CONTINUE;
    END IF;

    v_item_metadata := COALESCE(v_item->'metadata', '{}'::jsonb);
    IF jsonb_typeof(v_item_metadata) <> 'object' THEN
      v_item_metadata := '{}'::jsonb;
    END IF;

    v_assignment_defaults := COALESCE(v_item_metadata->'assignment_defaults', '{}'::jsonb);
    IF jsonb_typeof(v_assignment_defaults) <> 'object' THEN
      v_assignment_defaults := '{}'::jsonb;
    END IF;

    v_assignment_defaults := v_assignment_defaults || COALESCE(
      v_desired_item #> ARRAY['metadata', 'assignment_defaults'],
      '{}'::jsonb
    );
    v_item_metadata := jsonb_set(v_item_metadata, '{assignment_defaults}', v_assignment_defaults, TRUE);

    v_item := jsonb_set(v_item, '{default_queue_key}', to_jsonb('dispatch'::text), TRUE);
    v_item := jsonb_set(v_item, '{metadata}', v_item_metadata, TRUE);

    v_updated_task_types := v_updated_task_types || jsonb_build_array(v_item);
  END LOOP;

  FOR v_desired_item IN
    SELECT value
      FROM jsonb_array_elements(v_desired)
  LOOP
    v_key := lower(NULLIF(btrim(COALESCE(v_desired_item->>'key', '')), ''));
    IF v_key IS NULL THEN
      CONTINUE;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_updated_task_types) AS existing(value)
       WHERE lower(NULLIF(btrim(COALESCE(existing.value->>'key', '')), '')) = v_key
    ) THEN
      v_updated_task_types := v_updated_task_types || jsonb_build_array(v_desired_item);
    END IF;
  END LOOP;

  IF v_updated_task_types IS NOT DISTINCT FROM v_prev_task_types THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_existing, '{task_types}', v_updated_task_types, TRUE);

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
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    'task_type_catalog',
    'global',
    NULL::uuid,
    v_scope_hash,
    v_next_version,
    v_policy,
    1,
    'Add dispatch follow-up assignment defaults to task_type_catalog',
    workflow_now(),
    workflow_now()
  );

  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
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
-- 2) Backfill existing task_types rows with canonical assignment defaults
-------------------------------------------------------------------------------

WITH target_defaults AS (
  SELECT *
  FROM (
    VALUES
      ('dispatch_exception_review'::text, 'dispatch'::text, 60::int, 'ops_admin'::text),
      ('dispatch_reschedule_delivery'::text, 'dispatch'::text, 60::int, 'ops_admin'::text),
      ('dispatch_reattempt_delivery'::text, 'dispatch'::text, 60::int, 'ops_admin'::text),
      ('dispatch_rto_pickup'::text, 'dispatch'::text, 60::int, 'ops_admin'::text)
  ) AS t(task_type_key, queue_key, sla_minutes, assigned_to_user_type)
)
UPDATE public.task_types tt
   SET default_queue_key = CASE
         WHEN tt.default_queue_key IS NULL
           OR btrim(tt.default_queue_key) = ''
           OR lower(tt.default_queue_key) = 'default'
           THEN td.queue_key
         ELSE tt.default_queue_key
       END,
       metadata = jsonb_set(
         COALESCE(tt.metadata, '{}'::jsonb),
         '{assignment_defaults}',
         COALESCE(COALESCE(tt.metadata, '{}'::jsonb)->'assignment_defaults', '{}'::jsonb)
           || jsonb_build_object(
             'queue_key', td.queue_key,
             'sla_minutes', td.sla_minutes,
             'assigned_to_user_type', td.assigned_to_user_type
           ),
         TRUE
       ),
       updated_at = now()
  FROM target_defaults td
 WHERE tt.key = td.task_type_key;

-------------------------------------------------------------------------------
-- 3) Service-only helper: resolve assignee from task_type assignment defaults
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_task_assignee_user_v1(
  p_organization_id UUID,
  p_branch_id UUID DEFAULT NULL,
  p_assignment JSONB DEFAULT '{}'::jsonb
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_assignment JSONB := COALESCE(p_assignment, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_assigned_to_user_id UUID := NULL;
  v_branch_role_key TEXT := NULL;
  v_user_type TEXT := NULL;
  v_resolved_user_id UUID := NULL;
BEGIN
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
    RAISE EXCEPTION 'resolve_task_assignee_user_v1 requires service_role context';
  END IF;

  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'resolve_task_assignee_user_v1 requires organization_id' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_assignment) <> 'object' THEN
    RETURN NULL;
  END IF;

  BEGIN
    v_assigned_to_user_id := NULLIF(v_assignment->>'assigned_to_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_assigned_to_user_id := NULL;
  END;
  v_branch_role_key := lower(NULLIF(btrim(COALESCE(v_assignment->>'assigned_to_branch_role_key', '')), ''));
  v_user_type := lower(NULLIF(btrim(COALESCE(v_assignment->>'assigned_to_user_type', '')), ''));

  IF v_assigned_to_user_id IS NOT NULL THEN
    SELECT u.id
      INTO v_resolved_user_id
      FROM public.users u
     WHERE u.id = v_assigned_to_user_id
       AND u.organization_id = p_organization_id
       AND lower(COALESCE(NULLIF(btrim(u.status), ''), 'active')) = 'active'
     LIMIT 1;

    RETURN v_resolved_user_id;
  END IF;

  IF p_branch_id IS NOT NULL AND v_branch_role_key IS NOT NULL THEN
    SELECT bm.user_id
      INTO v_resolved_user_id
      FROM public.branch_memberships bm
      JOIN public.users u
        ON u.id = bm.user_id
     WHERE bm.branch_id = p_branch_id
       AND bm.role_key = v_branch_role_key
       AND bm.is_active = TRUE
       AND bm.effective_from <= now()
       AND (bm.effective_to IS NULL OR bm.effective_to > now())
       AND u.organization_id = p_organization_id
       AND lower(COALESCE(NULLIF(btrim(u.status), ''), 'active')) = 'active'
     ORDER BY bm.effective_from DESC, bm.created_at DESC, bm.user_id
     LIMIT 1;

    IF v_resolved_user_id IS NOT NULL THEN
      RETURN v_resolved_user_id;
    END IF;
  END IF;

  IF v_user_type IS NOT NULL THEN
    SELECT u.id
      INTO v_resolved_user_id
      FROM public.users u
     WHERE u.organization_id = p_organization_id
       AND lower(COALESCE(NULLIF(btrim(u.user_type), ''), '')) = v_user_type
       AND lower(COALESCE(NULLIF(btrim(u.status), ''), 'active')) = 'active'
     ORDER BY
       CASE
         WHEN lower(COALESCE(NULLIF(btrim(u.access_scope_type), ''), 'tenant')) = 'tenant' THEN 0
         ELSE 1
       END,
       u.created_at,
       u.id
     LIMIT 1;
  END IF;

  RETURN v_resolved_user_id;
END;
$function$;

COMMENT ON FUNCTION public.resolve_task_assignee_user_v1(UUID, UUID, JSONB)
  IS 'Service-only helper that resolves a task assignee from task_type metadata.assignment_defaults using explicit user, branch role, then user_type fallback.';

REVOKE ALL ON FUNCTION public.resolve_task_assignee_user_v1(UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_task_assignee_user_v1(UUID, UUID, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.resolve_task_assignee_user_v1(UUID, UUID, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.resolve_task_assignee_user_v1(UUID, UUID, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 4) Canonical assign RPC: allow service_role + actor_system provenance
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_task_v1(
  p_task_id UUID,
  p_assigned_to UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := NULL;
  v_claims JSONB := NULL;
  v_jwt_role TEXT := NULL;
  v_is_platform BOOLEAN := FALSE;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(current_setting('app.actor_system', true), '')), '');
  v_task public.tasks%ROWTYPE;
  v_org_id UUID;
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_jwt_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF v_user_id IS NULL THEN
    IF v_jwt_role IS DISTINCT FROM 'service_role' THEN
      RAISE EXCEPTION 'assign_task_v1 requires an authenticated user or service_role context';
    END IF;
  ELSE
    v_is_platform := public.is_platform_user();

    IF NOT public.user_can_write() THEN
      RAISE EXCEPTION 'assign_task_v1 requires tenant/platform write scope';
    END IF;
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'assign_task_v1 requires task_id';
  END IF;
  IF p_assigned_to IS NULL THEN
    RAISE EXCEPTION 'assign_task_v1 requires assigned_to';
  END IF;

  SELECT *
    INTO v_task
    FROM public.tasks t
   WHERE t.id = p_task_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'assign_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF v_user_id IS NOT NULL
     AND COALESCE(v_is_platform, FALSE) IS NOT TRUE
     AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'assign_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  IF v_user_id IS NOT NULL AND NOT public.user_has_permission_v1('tasks.write', v_org_id) THEN
    RAISE EXCEPTION 'assign_task_v1 requires tasks.write permission' USING ERRCODE = '42501';
  END IF;

  PERFORM 1
    FROM public.users u
   WHERE u.id = p_assigned_to
     AND u.organization_id = v_org_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'assign_task_v1 assigned_to user % is outside organization_id %', p_assigned_to, v_org_id
      USING ERRCODE = '42501';
  END IF;

  IF v_idempotency IS NOT NULL THEN
    SELECT te.id
      INTO task_event_id
      FROM public.task_events te
     WHERE te.task_id = v_task.id
       AND te.idempotency_key = v_idempotency
     LIMIT 1;

    IF FOUND THEN
      task_id := v_task.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET assigned_to = p_assigned_to,
         assigned_at = now(),
         version = v_next_version
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'assign',
    p_decision_outcome := 'assigned',
    p_performed_by_system := COALESCE(v_actor_system, 'assign_task_v1'),
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'assigned_to', p_assigned_to,
      'notes', p_notes
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.task_events (
    task_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    task_version,
    decision_log_id,
    settings_resolution_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'assigned',
    v_task.status,
    v_task.status,
    v_user_id,
    v_actor_system,
    jsonb_strip_nulls(jsonb_build_object(
      'assigned_to', p_assigned_to,
      'notes', p_notes,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT)
  IS 'Assign a task to a user (projection update + ledger event). Authenticated calls enforce tenant RBAC; service_role callers may stamp actor_system provenance via app.actor_system.';

REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task_v1(UUID, UUID, TEXT, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 5) Service-only assign wrapper for workflow/system callers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_task_system_v1(
  p_task_id UUID,
  p_assigned_to UUID,
  p_idempotency_key TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_actor_system TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_actor_system TEXT := COALESCE(NULLIF(btrim(COALESCE(p_actor_system, '')), ''), 'task_system');
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
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
    RAISE EXCEPTION 'assign_task_system_v1 requires service_role context';
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', v_actor_system, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);
  BEGIN
    RETURN QUERY
    SELECT *
      FROM public.assign_task_v1(
        p_task_id,
        p_assigned_to,
        p_idempotency_key,
        p_notes
      );
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$function$;

COMMENT ON FUNCTION public.assign_task_system_v1(UUID, UUID, TEXT, TEXT, TEXT)
  IS 'Service-only wrapper over assign_task_v1 for workflow/system contexts. Forces service_role claims locally and stamps actor_system provenance.';

REVOKE ALL ON FUNCTION public.assign_task_system_v1(UUID, UUID, TEXT, TEXT, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.assign_task_system_v1(UUID, UUID, TEXT, TEXT, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.assign_task_system_v1(UUID, UUID, TEXT, TEXT, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.assign_task_system_v1(UUID, UUID, TEXT, TEXT, TEXT) TO service_role;

-------------------------------------------------------------------------------
-- 6) create_task_system_v1: inherit queue/SLA defaults from task_type metadata
--    and persist inherited assignment defaults onto task metadata for downstream task routing.
-------------------------------------------------------------------------------

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
AS $function$
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
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
  v_org_id UUID := NULL;
  v_task_type RECORD;
  v_assignment_defaults JSONB := '{}'::jsonb;
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
  BEGIN
    v_resource_id := NULLIF(v_input->>'resource_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_resource_id := NULL;
  END;
  v_queue_key := NULLIF(btrim(COALESCE(v_input->>'queue_key', '')), '');
  BEGIN
    v_priority := NULLIF(v_input->>'priority', '')::int;
  EXCEPTION
    WHEN others THEN
      v_priority := NULL;
  END;
  BEGIN
    v_sla_minutes := NULLIF(v_input->>'sla_minutes', '')::int;
  EXCEPTION
    WHEN others THEN
      v_sla_minutes := NULL;
  END;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  v_actor_system := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;
  IF v_org_id IS NOT NULL THEN
    PERFORM public.ensure_task_type_from_catalog_v1(v_org_id, v_task_type_key, v_context);

    SELECT
      tt.id,
      tt.default_queue_key,
      tt.metadata
      INTO v_task_type
      FROM public.task_types tt
     WHERE tt.organization_id = v_org_id
       AND tt.key = v_task_type_key
     LIMIT 1;

    IF jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)) = 'object'
       AND jsonb_typeof(COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults') = 'object' THEN
      v_assignment_defaults := COALESCE(v_task_type.metadata, '{}'::jsonb)->'assignment_defaults';
    END IF;

    IF v_queue_key IS NULL THEN
      v_queue_key := NULLIF(btrim(COALESCE(v_assignment_defaults->>'queue_key', '')), '');
    END IF;

    IF v_sla_minutes IS NULL THEN
      BEGIN
        v_sla_minutes := NULLIF(v_assignment_defaults->>'sla_minutes', '')::int;
      EXCEPTION
        WHEN others THEN
          v_sla_minutes := NULL;
      END;
    END IF;

    IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
      v_metadata := '{}'::jsonb;
    END IF;

    IF jsonb_typeof(COALESCE(v_metadata->'assignment_defaults', 'null'::jsonb)) IS DISTINCT FROM 'object'
       AND jsonb_typeof(v_assignment_defaults) = 'object'
       AND v_assignment_defaults <> '{}'::jsonb THEN
      v_metadata := jsonb_set(v_metadata, '{assignment_defaults}', v_assignment_defaults, TRUE);
    END IF;
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', COALESCE(v_actor_system, ''), true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
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
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);
END;
$function$;

COMMENT ON FUNCTION public.create_task_system_v1(JSONB)
  IS 'Service-only wrapper to create a task via create_task_v1. Ensures task_types exist from task_type_catalog and inherits queue/SLA defaults from task_type metadata.assignment_defaults when payload omits them.';

REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_task_system_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_task_system_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 7) route_stop_finalize -> v5: auto-assign follow-up tasks from task type defaults
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION workflow_handlers.execute_route_stop_finalize_v5(
  p_step public.workflow_run_steps,
  p_run public.workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS public.workflow_handler_response
LANGUAGE plpgsql
AS $function$
DECLARE
  v_resp public.workflow_handler_response;
  v_operation_result JSONB := '{}'::jsonb;
  v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
  v_route_stop_id UUID := NULL;
  v_route_stop RECORD;
  v_followup_task_ids JSONB := '[]'::jsonb;
  v_followup_task_id_text TEXT;
  v_followup_task_id UUID := NULL;
  v_task RECORD;
  v_assignment_defaults JSONB := '{}'::jsonb;
  v_assigned_to UUID := NULL;
BEGIN
  v_resp := workflow_handlers.execute_route_stop_finalize_v4(
    p_step,
    p_run,
    p_operation_result
  );

  IF COALESCE(v_resp.status, '') <> 'completed' THEN
    RETURN v_resp;
  END IF;

  v_operation_result := COALESCE(v_resp.operation_result, '{}'::jsonb);
  BEGIN
    v_route_stop_id := NULLIF(
      COALESCE(
        v_operation_result->>'route_stop_id',
        v_context->>'resource_id',
        ''
      ),
      ''
    )::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_stop_id := NULL;
  END;

  IF v_route_stop_id IS NULL THEN
    RETURN v_resp;
  END IF;

  SELECT
    rs.organization_id,
    rr.branch_id
    INTO v_route_stop
    FROM public.route_stops rs
    JOIN public.route_runs rr
      ON rr.id = rs.route_run_id
   WHERE rs.id = v_route_stop_id
   LIMIT 1;

  IF v_route_stop.organization_id IS NULL THEN
    RETURN v_resp;
  END IF;

  v_followup_task_ids := COALESCE(v_operation_result->'followup_task_ids', '[]'::jsonb);
  IF jsonb_typeof(v_followup_task_ids) <> 'array' THEN
    RETURN v_resp;
  END IF;

  FOR v_followup_task_id_text IN
    SELECT value
      FROM jsonb_array_elements_text(v_followup_task_ids) AS ids(value)
  LOOP
    BEGIN
      v_followup_task_id := NULLIF(v_followup_task_id_text, '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_followup_task_id := NULL;
    END;

    IF v_followup_task_id IS NULL THEN
      CONTINUE;
    END IF;

    SELECT
      t.id,
      t.assigned_to,
      tt.metadata
      INTO v_task
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.id = v_followup_task_id
     LIMIT 1;

    IF v_task.id IS NULL OR v_task.assigned_to IS NOT NULL THEN
      CONTINUE;
    END IF;

    v_assignment_defaults := '{}'::jsonb;
    IF jsonb_typeof(COALESCE(v_task.metadata, '{}'::jsonb)) = 'object'
       AND jsonb_typeof(COALESCE(v_task.metadata, '{}'::jsonb)->'assignment_defaults') = 'object' THEN
      v_assignment_defaults := COALESCE(v_task.metadata, '{}'::jsonb)->'assignment_defaults';
    END IF;

    IF v_assignment_defaults = '{}'::jsonb THEN
      CONTINUE;
    END IF;

    v_assigned_to := public.resolve_task_assignee_user_v1(
      v_route_stop.organization_id,
      v_route_stop.branch_id,
      v_assignment_defaults
    );

    IF v_assigned_to IS NULL THEN
      CONTINUE;
    END IF;

    PERFORM *
      FROM public.assign_task_system_v1(
        v_followup_task_id,
        v_assigned_to,
        format('dispatch_stop_followup_assign:%s:%s', p_run.id, v_followup_task_id),
        'Auto-assigned from task type assignment_defaults',
        'dispatch_engine'
      );
  END LOOP;

  RETURN v_resp;
END;
$function$;

ALTER TABLE public.operation_handlers DISABLE TRIGGER operation_handlers_validate_signature;

INSERT INTO public.operation_handlers (
  handler_key,
  handler_schema,
  handler_name,
  handler_signature,
  handler_version,
  is_active,
  notes,
  doc_url
)
VALUES (
  'route_stop_finalize',
  'workflow_handlers',
  'execute_route_stop_finalize_v5',
  '(workflow_run_steps,workflow_runs,jsonb)',
  'v5',
  TRUE,
  'Finalize a dispatch route_stop execution, then auto-assign any created follow-up tasks from task type assignment_defaults via service-only task routing.',
  'docs/product/guides/handlers-cookbook.md'
)
ON CONFLICT (handler_key) DO UPDATE
SET handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

ALTER TABLE public.operation_handlers ENABLE TRIGGER operation_handlers_validate_signature;

DO $do$
DECLARE
  v_template_id UUID;
BEGIN
  SELECT id
    INTO v_template_id
    FROM public.workflow_templates
   WHERE name = 'dispatch_route_stop_finalize_v1'
   LIMIT 1;

  IF v_template_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.workflow_template_steps
     SET handler_version = 'v5',
         updated_at = now()
   WHERE workflow_template_id = v_template_id
     AND handler_key = 'route_stop_finalize';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604032100_task_assignment_defaults_and_ndr_followups_v1'));
COMMIT;
