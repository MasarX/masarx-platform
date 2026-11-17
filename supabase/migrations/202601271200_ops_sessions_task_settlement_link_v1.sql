-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Ops session linkage for task + settlement ledgers (queryable provenance)
-- Date: 2026-01-27
--
-- Goals:
--   - Persist ops_session provenance on task_events + settlement_events (query-friendly; not JSON-only).
--   - Validate ops_session_id dynamically (org match + actor match; status finality via lookup metadata).
--   - Preserve least-privilege: tenant writes remain via RPCs; service writes remain service-only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601271200_ops_sessions_task_settlement_link_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 0) ops_session_status semantics (row-driven): mark final statuses
-------------------------------------------------------------------------------

UPDATE public.lookup_values lv
   SET metadata = jsonb_set(
     COALESCE(lv.metadata, '{}'::jsonb),
     '{is_final}',
     to_jsonb(CASE WHEN lv.value IN ('closed', 'canceled') THEN TRUE ELSE FALSE END),
     TRUE
   )
  FROM public.lookup_definitions ld
 WHERE ld.id = lv.lookup_definition_id
   AND ld.category = 'ops_session_status'
   AND lv.value IN ('open', 'closed', 'canceled');

-------------------------------------------------------------------------------
-- 1) task_events: add optional ops_session_id FK
-------------------------------------------------------------------------------

ALTER TABLE public.task_events
  ADD COLUMN IF NOT EXISTS ops_session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'task_events'
      AND c.conname = 'task_events_ops_session_id_fkey'
  ) THEN
    ALTER TABLE public.task_events
      ADD CONSTRAINT task_events_ops_session_id_fkey
      FOREIGN KEY (ops_session_id)
      REFERENCES public.ops_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_task_events_ops_session_id
  ON public.task_events (ops_session_id)
  WHERE ops_session_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 2) settlement_events: add optional ops_session_id FK
-------------------------------------------------------------------------------

ALTER TABLE public.settlement_events
  ADD COLUMN IF NOT EXISTS ops_session_id UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint c
    JOIN pg_class t ON t.oid = c.conrelid
    JOIN pg_namespace n ON n.oid = t.relnamespace
    WHERE n.nspname = 'public'
      AND t.relname = 'settlement_events'
      AND c.conname = 'settlement_events_ops_session_id_fkey'
  ) THEN
    ALTER TABLE public.settlement_events
      ADD CONSTRAINT settlement_events_ops_session_id_fkey
      FOREIGN KEY (ops_session_id)
      REFERENCES public.ops_sessions(id)
      ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_settlement_events_ops_session_id
  ON public.settlement_events (ops_session_id)
  WHERE ops_session_id IS NOT NULL;

-------------------------------------------------------------------------------
-- 3) transition_task_v1: accept ops_session_id in payload and persist to ledger
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_task_v1(
  p_task_id UUID,
  p_to_status TEXT,
  p_status_reason TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_idempotency_key TEXT DEFAULT NULL
)
RETURNS TABLE (
  task_id UUID,
  task_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID;
  v_is_platform BOOLEAN := public.is_platform_user();
  v_task public.tasks%ROWTYPE;
  v_org_id UUID;
  v_from_status TEXT;
  v_to_status TEXT := lower(COALESCE(NULLIF(p_to_status, ''), ''));
  v_idempotency TEXT := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  v_decision_id UUID;
  v_next_version INT;

  v_payload JSONB := COALESCE(p_payload, '{}'::jsonb);
  v_ops_session_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_actor UUID := NULL;
  v_ops_session_status TEXT := NULL;
  v_ops_session_is_final BOOLEAN := FALSE;
BEGIN
  SELECT auth.uid() INTO v_user_id;
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires an authenticated user';
  END IF;
  IF NOT public.user_can_write() THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope';
  END IF;
  IF p_task_id IS NULL THEN
    RAISE EXCEPTION 'transition_task_v1 requires task_id';
  END IF;
  IF v_to_status = '' THEN
    RAISE EXCEPTION 'transition_task_v1 requires to_status';
  END IF;

  SELECT * INTO v_task
  FROM public.tasks t
  WHERE t.id = p_task_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_task_v1 task not found: %', p_task_id;
  END IF;

  v_org_id := v_task.organization_id;
  IF NOT v_is_platform AND v_org_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'transition_task_v1 task % is outside current tenant scope', p_task_id
      USING ERRCODE = '42501';
  END IF;

  -- Idempotency short-circuit (must happen after locking the task row).
  IF v_idempotency IS NOT NULL THEN
    SELECT te.id INTO task_event_id
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

  IF jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN
    v_ops_session_id := NULLIF(btrim(COALESCE(v_payload->>'ops_session_id', v_payload->>'session_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_ops_session_id := NULL;
  END;

  IF v_ops_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.actor_user_id, s.status
      INTO v_ops_session_org, v_ops_session_actor, v_ops_session_status
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
     LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session_id not found: %', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;

    IF v_ops_session_org IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session org mismatch (task org %, session org %)', v_org_id, v_ops_session_org
        USING ERRCODE = '23514';
    END IF;

    IF NOT v_is_platform AND v_ops_session_actor IS DISTINCT FROM v_user_id THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session actor mismatch (session actor %, current user %)', v_ops_session_actor, v_user_id
        USING ERRCODE = '42501';
    END IF;

    SELECT COALESCE((lv.metadata->>'is_final')::boolean, FALSE)
      INTO v_ops_session_is_final
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'ops_session_status'
       AND lv.value = v_ops_session_status
     LIMIT 1;

    IF COALESCE(v_ops_session_is_final, FALSE) IS TRUE THEN
      RAISE EXCEPTION 'transition_task_v1 ops_session is final (status=%)', v_ops_session_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Avoid redundant storage: keep session link in the dedicated column.
  v_payload := (v_payload - 'ops_session_id' - 'session_id');

  v_from_status := v_task.status;
  v_next_version := v_task.version + 1;

  UPDATE public.tasks
     SET status = v_to_status,
         status_reason = p_status_reason,
         version = v_next_version,
         started_at = CASE WHEN started_at IS NULL THEN now() ELSE started_at END,
         completed_at = CASE WHEN v_to_status = 'completed' THEN now() ELSE completed_at END,
         canceled_at = CASE WHEN v_to_status = 'canceled' THEN now() ELSE canceled_at END
   WHERE id = v_task.id
   RETURNING * INTO v_task;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'task',
    p_resource_type := 'task',
    p_resource_id := v_task.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_task_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', p_status_reason,
      'ops_session_id', v_ops_session_id
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
    settings_resolution_id,
    ops_session_id
  )
  VALUES (
    v_task.id,
    v_org_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_user_id,
    NULL,
    jsonb_strip_nulls(v_payload || jsonb_build_object(
      'status_reason', p_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    NULL,
    v_ops_session_id
  )
  RETURNING id INTO task_event_id;

  task_id := v_task.id;
  RETURN NEXT;
END;
$$;

COMMENT ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT)
  IS 'Transition a task status (projection update + ledger event). Supports optional ops_session_id linkage via payload for execution provenance.';

REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_task_v1(UUID, TEXT, TEXT, JSONB, TEXT) TO authenticated, service_role;

-------------------------------------------------------------------------------
-- 4) transition_settlement_batch_v1: accept ops_session_id and persist to ledger
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.transition_settlement_batch_v1(
  p_transition JSONB
)
RETURNS TABLE (
  settlement_batch_id UUID,
  settlement_event_id UUID
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_transition, '{}'::jsonb);

  v_batch_id UUID;
  v_to_status TEXT := lower(NULLIF(btrim(COALESCE(v_input->>'to_status', '')), ''));
  v_status_reason TEXT := NULLIF(btrim(COALESCE(v_input->>'status_reason', '')), '');
  v_payload JSONB := COALESCE(v_input->'payload', '{}'::jsonb);
  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');

  v_ops_session_id UUID := NULL;
  v_ops_session_org UUID := NULL;
  v_ops_session_status TEXT := NULL;
  v_ops_session_is_final BOOLEAN := FALSE;

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  v_batch public.settlement_batches%ROWTYPE;
  v_from_status TEXT;
  v_next_version INT;

  v_policy_ctx JSONB;
  v_settlement_policy_row RECORD;
  v_settlement_policy_resolution_id UUID := NULL;

  v_decision_id UUID := NULL;
  v_status_meta JSONB := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_payload) <> 'object' THEN
    v_payload := '{}'::jsonb;
  END IF;

  BEGIN v_batch_id := NULLIF(v_input->>'settlement_batch_id', '')::UUID; EXCEPTION WHEN others THEN v_batch_id := NULL; END;
  IF v_batch_id IS NULL THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 requires settlement_batch_id' USING ERRCODE = '23514';
  END IF;
  IF v_to_status IS NULL THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 requires to_status' USING ERRCODE = '23514';
  END IF;

  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  BEGIN
    v_ops_session_id := NULLIF(btrim(COALESCE(v_input->>'ops_session_id', v_input->>'session_id', '')), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_ops_session_id := NULL;
  END;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_status'
    AND lv.value = v_to_status
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 invalid to_status: %', v_to_status USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_batch
  FROM public.settlement_batches b
  WHERE b.id = v_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 settlement_batch not found: %', v_batch_id;
  END IF;

  -- Idempotency short-circuit (must happen after locking the batch row).
  IF v_idempotency IS NOT NULL THEN
    SELECT e.id INTO settlement_event_id
    FROM public.settlement_events e
    WHERE e.settlement_batch_id = v_batch.id
      AND e.idempotency_key = v_idempotency
    LIMIT 1;
    IF FOUND THEN
      settlement_batch_id := v_batch.id;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_ops_session_id IS NOT NULL THEN
    SELECT s.organization_id, s.status
      INTO v_ops_session_org, v_ops_session_status
      FROM public.ops_sessions s
     WHERE s.id = v_ops_session_id
     LIMIT 1;

    IF v_ops_session_org IS NULL THEN
      RAISE EXCEPTION 'transition_settlement_batch_v1 ops_session_id not found: %', v_ops_session_id
        USING ERRCODE = '23503';
    END IF;

    IF v_ops_session_org IS DISTINCT FROM v_batch.organization_id THEN
      RAISE EXCEPTION 'transition_settlement_batch_v1 ops_session org mismatch (batch org %, session org %)', v_batch.organization_id, v_ops_session_org
        USING ERRCODE = '23514';
    END IF;

    SELECT COALESCE((lv.metadata->>'is_final')::boolean, FALSE)
      INTO v_ops_session_is_final
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'ops_session_status'
       AND lv.value = v_ops_session_status
     LIMIT 1;

    IF COALESCE(v_ops_session_is_final, FALSE) IS TRUE THEN
      RAISE EXCEPTION 'transition_settlement_batch_v1 ops_session is final (status=%)', v_ops_session_status
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Disallow transitions from final statuses (row-driven via lookup metadata).
  SELECT COALESCE(lv.metadata, '{}'::jsonb)
    INTO v_status_meta
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'settlement_status'
     AND lv.value = v_batch.status
     AND lv.status = 'active'
   LIMIT 1;

  IF COALESCE((v_status_meta->>'is_final')::BOOLEAN, FALSE) IS TRUE THEN
    RAISE EXCEPTION 'transition_settlement_batch_v1 batch is in final status: %', v_batch.status
      USING ERRCODE = '23514';
  END IF;

  v_from_status := v_batch.status;
  v_next_version := v_batch.version + 1;

  UPDATE public.settlement_batches
     SET status = v_to_status,
         status_reason = v_status_reason,
         version = v_next_version
   WHERE id = v_batch.id
   RETURNING * INTO v_batch;

  -- Resolve settlement policy for provenance (based on batch anchors).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_batch.organization_id,
    'client_id', v_batch.client_id,
    'sender_id', v_batch.sender_id,
    'resource_id', v_batch.branch_id
  ));

  SELECT * INTO v_settlement_policy_row
    FROM public.resolve_settlement_policy(v_policy_ctx)
   LIMIT 1;

  IF FOUND AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_batch.organization_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'event_type', 'status_changed',
        'from_status', v_from_status,
        'to_status', v_to_status,
        'ops_session_id', v_ops_session_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_batch.organization_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := v_batch.id,
    p_decision_point := 'transition',
    p_decision_outcome := 'status_changed',
    p_performed_by_system := 'transition_settlement_batch_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'from_status', v_from_status,
      'to_status', v_to_status,
      'status_reason', v_status_reason,
      'ops_session_id', v_ops_session_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settlement_policy_resolution_id
  );

  INSERT INTO public.settlement_events (
    settlement_batch_id,
    organization_id,
    event_type,
    from_status,
    to_status,
    actor_user_id,
    actor_system,
    payload,
    idempotency_key,
    batch_version,
    decision_log_id,
    settings_resolution_id,
    ops_session_id
  )
  VALUES (
    v_batch.id,
    v_batch.organization_id,
    'status_changed',
    v_from_status,
    v_to_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'transition_settlement_batch_v1'),
    jsonb_strip_nulls(COALESCE(v_payload, '{}'::jsonb) || jsonb_build_object(
      'status_reason', v_status_reason,
      'correlation_id', public.current_correlation_id()
    )),
    v_idempotency,
    v_next_version,
    v_decision_id,
    v_settlement_policy_resolution_id,
    v_ops_session_id
  )
  RETURNING id INTO settlement_event_id;

  settlement_batch_id := v_batch.id;
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.transition_settlement_batch_v1(JSONB) IS
  'Service write-path: transition settlement batch status (projection update + ledger event; idempotent). Supports optional ops_session_id linkage for execution provenance.';

REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.transition_settlement_batch_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.transition_settlement_batch_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601271200_ops_sessions_task_settlement_link_v1'));
COMMIT;

