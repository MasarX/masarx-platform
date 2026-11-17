-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix create_settlement_batch_v1 idempotency ambiguity (plpgsql variable vs column)
-- Date: 2026-01-21

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212880_settlement_create_idempotency_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_settlement_batch_v1(
  p_batch JSONB
)
RETURNS TABLE (
  settlement_batch_id UUID,
  settlement_event_id UUID,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_batch, '{}'::jsonb);
  v_now TIMESTAMPTZ := now();

  v_org_id UUID;
  v_branch_id UUID := NULL;
  v_client_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_webhook_source_id UUID := NULL;

  v_kind TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_subject_type TEXT := NULL;
  v_subject_id UUID := NULL;
  v_window_start TIMESTAMPTZ := NULL;
  v_window_end TIMESTAMPTZ := NULL;

  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), '');

  v_idempotency TEXT := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_metadata JSONB := COALESCE(v_input->'metadata', '{}'::jsonb);

  v_policy_ctx JSONB;
  v_settlement_policy_row RECORD;
  v_cod_policy_row RECORD;
  v_has_settlement_policy BOOLEAN := FALSE;
  v_has_cod_policy BOOLEAN := FALSE;
  v_settlement_policy JSONB := '{}'::jsonb;
  v_cod_policy JSONB := '{}'::jsonb;

  v_settlement_policy_resolution_id UUID := NULL;
  v_cod_policy_resolution_id UUID := NULL;

  v_status TEXT := NULL;
  v_decision_id UUID := NULL;

  v_existing_batch_id UUID := NULL;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_org_id := NULLIF(v_input->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 missing organization_id' USING ERRCODE = '23514';
  END IF;

  BEGIN v_branch_id := NULLIF(v_input->>'branch_id', '')::UUID; EXCEPTION WHEN others THEN v_branch_id := NULL; END;
  BEGIN v_client_id := NULLIF(v_input->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_sender_id := NULLIF(v_input->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_webhook_source_id := NULLIF(v_input->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_webhook_source_id := NULL; END;

  v_kind := lower(NULLIF(btrim(COALESCE(v_input->>'kind', '')), ''));
  v_scope_type := lower(NULLIF(btrim(COALESCE(v_input->>'scope_type', '')), ''));
  v_subject_type := lower(NULLIF(btrim(COALESCE(v_input->>'subject_type', '')), ''));
  BEGIN v_subject_id := NULLIF(v_input->>'subject_id', '')::UUID; EXCEPTION WHEN others THEN v_subject_id := NULL; END;
  BEGIN v_window_start := NULLIF(v_input->>'window_start_at', '')::timestamptz; EXCEPTION WHEN others THEN v_window_start := NULL; END;
  BEGIN v_window_end := NULLIF(v_input->>'window_end_at', '')::timestamptz; EXCEPTION WHEN others THEN v_window_end := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::UUID; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;

  IF v_scope_type IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 requires scope_type' USING ERRCODE = '23514';
  END IF;

  -- Validate/resolve kind from lookup when omitted.
  IF v_kind IS NULL THEN
    SELECT lv.value
      INTO v_kind
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'settlement_kind'
       AND lv.is_default IS TRUE
       AND lv.status = 'active'
     ORDER BY COALESCE(lv.sort_order, 0), lv.value
     LIMIT 1;
  END IF;
  IF v_kind IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 could not resolve default settlement_kind' USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_kind'
    AND lv.value = v_kind
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 invalid kind: %', v_kind USING ERRCODE = '23514';
  END IF;

  PERFORM 1
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'settlement_scope_type'
    AND lv.value = v_scope_type
    AND lv.status = 'active'
  LIMIT 1;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 invalid scope_type: %', v_scope_type USING ERRCODE = '23514';
  END IF;

  -- Default status from lookup.
  SELECT lv.value
    INTO v_status
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
   WHERE ld.category = 'settlement_status'
     AND lv.is_default IS TRUE
     AND lv.status = 'active'
   ORDER BY COALESCE(lv.sort_order, 0), lv.value
   LIMIT 1;
  IF v_status IS NULL THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 could not resolve default settlement_status' USING ERRCODE = '23514';
  END IF;

  -- Validate commercial references (best-effort; no hardcoded branches).
  IF v_client_id IS NOT NULL THEN
    PERFORM 1
    FROM public.clients c
    WHERE c.id = v_client_id
      AND c.organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 client_id % is outside organization_id %', v_client_id, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_sender_id IS NOT NULL THEN
    PERFORM 1
    FROM public.senders s
    JOIN public.clients c ON c.id = s.client_id
    WHERE s.id = v_sender_id
      AND c.organization_id = v_org_id
      AND (v_client_id IS NULL OR s.client_id = v_client_id);
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 sender_id % is invalid for organization/client context', v_sender_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF v_branch_id IS NOT NULL THEN
    PERFORM 1
    FROM public.branches b
    WHERE b.id = v_branch_id
      AND b.organization_id = v_org_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'create_settlement_batch_v1 branch_id % is outside organization_id %', v_branch_id, v_org_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Resolve policies via canonical ladder (agreement-as-resolution).
  v_policy_ctx := jsonb_strip_nulls(jsonb_build_object(
    'organization_id', v_org_id,
    'client_id', v_client_id,
    'sender_id', v_sender_id,
    'webhook_source_id', v_webhook_source_id,
    'resource_id', v_branch_id
  ));

  SELECT * INTO v_settlement_policy_row
    FROM public.resolve_settlement_policy(v_policy_ctx)
   LIMIT 1;
  v_has_settlement_policy := FOUND;

  IF v_has_settlement_policy AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy := v_settlement_policy_row.value;
  END IF;

  -- Enforce settlement_policy.batch_scopes when present (row-driven).
  IF jsonb_typeof(v_settlement_policy->'batch_scopes') = 'array'
     AND NOT (v_settlement_policy->'batch_scopes' ? v_scope_type)
  THEN
    RAISE EXCEPTION 'create_settlement_batch_v1 scope_type % not allowed by settlement_policy.batch_scopes', v_scope_type
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO v_cod_policy_row
    FROM public.resolve_cod_policy(v_policy_ctx)
   LIMIT 1;
  v_has_cod_policy := FOUND;

  IF v_has_cod_policy AND v_cod_policy_row.value IS NOT NULL THEN
    v_cod_policy := v_cod_policy_row.value;
  END IF;

  -- Insert the projection row. Use idempotency to dedupe concurrent retries without side effects.
  IF v_idempotency IS NOT NULL THEN
    INSERT INTO public.settlement_batches (
      organization_id,
      kind,
      scope_type,
      branch_id,
      client_id,
      sender_id,
      subject_type,
      subject_id,
      window_start_at,
      window_end_at,
      status,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_kind,
      v_scope_type,
      v_branch_id,
      v_client_id,
      v_sender_id,
      v_subject_type,
      v_subject_id,
      v_window_start,
      v_window_end,
      v_status,
      v_idempotency,
      1,
      COALESCE(v_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    ON CONFLICT (organization_id, idempotency_key)
    WHERE idempotency_key IS NOT NULL AND btrim(idempotency_key) <> ''
    DO NOTHING
    RETURNING id INTO settlement_batch_id;

    IF settlement_batch_id IS NULL THEN
      SELECT b.id
        INTO v_existing_batch_id
        FROM public.settlement_batches b
       WHERE b.organization_id = v_org_id
         AND b.idempotency_key = v_idempotency
       LIMIT 1;

      settlement_batch_id := v_existing_batch_id;

      SELECT e.id
        INTO settlement_event_id
        FROM public.settlement_events e
       WHERE e.settlement_batch_id = v_existing_batch_id
         AND e.idempotency_key = v_idempotency
       LIMIT 1;

      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  ELSE
    INSERT INTO public.settlement_batches (
      organization_id,
      kind,
      scope_type,
      branch_id,
      client_id,
      sender_id,
      subject_type,
      subject_id,
      window_start_at,
      window_end_at,
      status,
      idempotency_key,
      version,
      metadata,
      created_at,
      updated_at
    )
    VALUES (
      v_org_id,
      v_kind,
      v_scope_type,
      v_branch_id,
      v_client_id,
      v_sender_id,
      v_subject_type,
      v_subject_id,
      v_window_start,
      v_window_end,
      v_status,
      NULL,
      1,
      COALESCE(v_metadata, '{}'::jsonb),
      v_now,
      v_now
    )
    RETURNING id INTO settlement_batch_id;
  END IF;

  created := TRUE;

  -- Provenance (only for newly-created batches).
  IF v_has_settlement_policy AND v_settlement_policy_row.value IS NOT NULL THEN
    v_settlement_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'settlement_policy',
      p_winning_scope_type := v_settlement_policy_row.scope_type,
      p_winning_scope_id := v_settlement_policy_row.scope_id,
      p_winning_settings_id := v_settlement_policy_row.settings_id,
      p_winning_settings_version_id := v_settlement_policy_row.settings_version_id,
      p_winning_version := v_settlement_policy_row.version,
      p_scope_path := v_settlement_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'kind', v_kind,
        'scope_type', v_scope_type,
        'branch_id', v_branch_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  IF v_has_cod_policy AND v_cod_policy_row.value IS NOT NULL THEN
    v_cod_policy_resolution_id := public.log_settings_resolution(
      p_organization_id := v_org_id,
      p_category := 'cod_policy',
      p_winning_scope_type := v_cod_policy_row.scope_type,
      p_winning_scope_id := v_cod_policy_row.scope_id,
      p_winning_settings_id := v_cod_policy_row.settings_id,
      p_winning_settings_version_id := v_cod_policy_row.settings_version_id,
      p_winning_version := v_cod_policy_row.version,
      p_scope_path := v_cod_policy_row.scope_path,
      p_inputs := jsonb_strip_nulls(jsonb_build_object(
        'kind', v_kind,
        'scope_type', v_scope_type,
        'branch_id', v_branch_id
      )),
      p_merge_notes := NULL
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'settlement',
    p_resource_type := 'settlement_batch',
    p_resource_id := settlement_batch_id,
    p_decision_point := 'create',
    p_decision_outcome := 'created',
    p_performed_by_system := 'create_settlement_batch_v1',
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'kind', v_kind,
      'scope_type', v_scope_type,
      'branch_id', v_branch_id,
      'client_id', v_client_id,
      'sender_id', v_sender_id,
      'subject_type', v_subject_type,
      'subject_id', v_subject_id,
      'window_start_at', v_window_start,
      'window_end_at', v_window_end,
      'settlement_policy_settings_resolution_id', v_settlement_policy_resolution_id,
      'cod_policy_settings_resolution_id', v_cod_policy_resolution_id
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
    created_at
  )
  VALUES (
    settlement_batch_id,
    v_org_id,
    'created',
    NULL,
    v_status,
    v_actor_user_id,
    COALESCE(v_actor_system, 'create_settlement_batch_v1'),
    jsonb_strip_nulls(jsonb_build_object(
      'correlation_id', public.current_correlation_id(),
      'policy_context', v_policy_ctx,
      'settlement_policy', v_settlement_policy,
      'cod_policy', v_cod_policy
    )),
    v_idempotency,
    1,
    v_decision_id,
    v_settlement_policy_resolution_id,
    v_now
  )
  RETURNING id INTO settlement_event_id;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.create_settlement_batch_v1(JSONB) IS
  'Service write-path: create a settlement batch projection row + ledger event (idempotent by organization_id + idempotency_key).';

REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.create_settlement_batch_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.create_settlement_batch_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202601212880_settlement_create_idempotency_fix'));
COMMIT;

