-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S04
-- Migration: mark_branch_oos_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Bulk-mark branches out-of-service (is_active=FALSE) with idempotent envelope.
-- Args (jsonb):
--   { branch_ids (uuid[]), reason (text), metadata (jsonb) }
--   Single-branch fallback: { branch_id (uuid), reason, metadata }
-- Envelope: { ok, branch_ids[], updated_count, already_oos[], correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300230_mark_branch_oos_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.mark_branch_oos_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_input_ids UUID[] := ARRAY[]::uuid[];
  v_id UUID;
  v_branch RECORD;
  v_updated UUID[] := ARRAY[]::uuid[];
  v_already UUID[] := ARRAY[]::uuid[];
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'mark_branch_oos_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- Allow either branch_ids[] or branch_id
  IF jsonb_typeof(p_args->'branch_ids') = 'array' THEN
    SELECT ARRAY(
      SELECT (jsonb_array_elements_text(p_args->'branch_ids'))::uuid
    )
    INTO v_input_ids;
  ELSIF (p_args->>'branch_id') IS NOT NULL AND p_args->>'branch_id' <> '' THEN
    v_input_ids := ARRAY[(p_args->>'branch_id')::uuid];
  ELSE
    RAISE EXCEPTION 'mark_branch_oos_v1 requires branch_ids[] or branch_id' USING ERRCODE = '23502';
  END IF;

  IF array_length(v_input_ids, 1) IS NULL THEN
    RAISE EXCEPTION 'mark_branch_oos_v1 requires at least one branch_id' USING ERRCODE = '23502';
  END IF;

  -- Capability gate (per first row's org; tenant guard rechecks below)
  SELECT organization_id INTO v_target_org FROM public.branches WHERE id = v_input_ids[1];
  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_target_org);

  FOREACH v_id IN ARRAY v_input_ids LOOP
    SELECT * INTO v_branch FROM public.branches WHERE id = v_id FOR UPDATE;
    IF v_branch.id IS NULL THEN
      RAISE EXCEPTION 'mark_branch_oos_v1 branch % not found', v_id USING ERRCODE = '23503';
    END IF;

    IF NOT public.is_platform_user() AND v_branch.organization_id <> v_caller_org THEN
      RAISE EXCEPTION 'mark_branch_oos_v1 branch % outside tenant scope', v_id USING ERRCODE = '42501';
    END IF;

    IF v_branch.is_active = FALSE THEN
      v_already := array_append(v_already, v_id);
    ELSE
      UPDATE public.branches
         SET is_active = FALSE,
             metadata = COALESCE(metadata, '{}'::jsonb)
                     || jsonb_strip_nulls(jsonb_build_object(
                          'oos_at', to_jsonb(now()),
                          'oos_by_user_id', to_jsonb(v_user_id),
                          'oos_reason', v_reason
                        )),
             updated_at = now()
       WHERE id = v_id;
      v_updated := array_append(v_updated, v_id);

      INSERT INTO public.domain_events (
        organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
      ) VALUES (
        v_branch.organization_id, 'branch.marked_oos', 'branch', v_id, v_correlation_id,
        jsonb_strip_nulls(jsonb_build_object(
          'branch_id', v_id,
          'reason', v_reason,
          'metadata', v_metadata
        )),
        'pending'
      );
    END IF;
  END LOOP;

  v_decision_log_id := public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'branches.lifecycle',
    p_resource_type := 'branch',
    p_resource_id := v_input_ids[1],
    p_decision_point := 'mark_branch_oos_v1',
    p_decision_outcome := 'marked_oos',
    p_performed_by_system := 'mark_branch_oos_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'branch_ids', to_jsonb(v_input_ids),
      'reason', v_reason,
      'metadata', v_metadata,
      'updated_count', array_length(v_updated, 1),
      'already_count', array_length(v_already, 1)
    )),
    p_decision_reason := COALESCE(v_reason, 'mark_branch_oos_no_reason')
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_ids', to_jsonb(v_updated),
    'already_oos', to_jsonb(v_already),
    'updated_count', COALESCE(array_length(v_updated, 1), 0),
    'already_processed', (array_length(v_updated, 1) IS NULL),
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.mark_branch_oos_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mark_branch_oos_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.mark_branch_oos_v1(JSONB) IS
  'NETWORK W8 canonical write RPC: bulk-mark branches out-of-service (is_active=FALSE). Capability: branches.write. Idempotent.';

SELECT pg_advisory_unlock(hashtext('202604300230_mark_branch_oos_v1'));
COMMIT;
