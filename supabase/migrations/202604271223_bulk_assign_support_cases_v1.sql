-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: bulk_assign_support_cases_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Assign N support cases to a single user (or unassign all). Per-case isolation:
--   one bad case does not abort the cohort; result envelope reports per-case status.
--
-- Args (jsonb p_args):
--   support_case_ids   uuid[] (required, non-empty)
--   assigned_to        uuid|null (required; null = bulk unassign)
--   correlation_id     uuid (optional)
--
-- Returns:
--   { ok, count, success_count, failure_count, already_processed_count, items: [...] }
--   items[i] = { support_case_id, ok, status, error?, version? }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271223_bulk_assign_support_cases_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.bulk_assign_support_cases_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_assignee UUID;
  v_unassign BOOLEAN := FALSE;
  v_ids JSONB;
  v_id_text TEXT;
  v_case_id UUID;
  v_correlation_id UUID;
  v_per_args JSONB;
  v_result JSONB;
  v_items JSONB := '[]'::jsonb;
  v_count INT := 0;
  v_success INT := 0;
  v_failure INT := 0;
  v_already INT := 0;
  v_item_status TEXT;
  v_item_error JSONB;
BEGIN
  -- 1) Capability gate (single check; per-case calls reuse same gate result via SECURITY DEFINER chain).
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bulk_assign_support_cases_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- 2) Parse args.
  v_ids := COALESCE(v_args->'support_case_ids', '[]'::jsonb);
  IF jsonb_typeof(v_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'bulk_assign_support_cases_v1 requires support_case_ids array'
      USING ERRCODE = '23502';
  END IF;
  IF jsonb_array_length(v_ids) = 0 THEN
    RAISE EXCEPTION 'bulk_assign_support_cases_v1: support_case_ids must be non-empty'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (v_args ? 'assigned_to') THEN
    RAISE EXCEPTION 'bulk_assign_support_cases_v1 requires assigned_to (null to unassign)'
      USING ERRCODE = '23502';
  END IF;
  IF v_args->>'assigned_to' IS NULL OR btrim(v_args->>'assigned_to') = '' THEN
    v_unassign := TRUE;
    v_assignee := NULL;
  ELSE
    BEGIN v_assignee := NULLIF(v_args->>'assigned_to', '')::UUID;
    EXCEPTION WHEN others THEN
      RAISE EXCEPTION 'bulk_assign_support_cases_v1: invalid assigned_to uuid' USING ERRCODE = '22P02';
    END;
  END IF;

  BEGIN v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN v_correlation_id := gen_random_uuid(); END IF;

  -- 3) Iterate per-case (per-case isolation via savepoint pattern).
  FOR v_id_text IN SELECT jsonb_array_elements_text(v_ids) LOOP
    v_count := v_count + 1;
    v_item_status := NULL;
    v_item_error := NULL;
    BEGIN
      v_case_id := NULLIF(btrim(v_id_text), '')::UUID;
    EXCEPTION WHEN others THEN
      v_item_error := jsonb_build_object('code', 'invalid_support_case_id', 'value', v_id_text);
      v_item_status := 'invalid_id';
      v_failure := v_failure + 1;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'ok', FALSE,
        'support_case_id', NULL,
        'status', v_item_status,
        'error', v_item_error
      ));
      CONTINUE;
    END;

    BEGIN
      v_per_args := jsonb_strip_nulls(jsonb_build_object(
        'support_case_id', v_case_id,
        'assigned_to', CASE WHEN v_unassign THEN NULL ELSE v_assignee END,
        'correlation_id', v_correlation_id
      ));
      -- Force null preservation for unassign:
      IF v_unassign THEN
        v_per_args := v_per_args || jsonb_build_object('assigned_to', NULL::JSONB);
      END IF;

      v_result := public.assign_support_case_v1(v_per_args);

      IF COALESCE((v_result->>'already_processed')::boolean, FALSE) THEN
        v_already := v_already + 1;
        v_item_status := 'already_processed';
      ELSIF COALESCE((v_result->>'ok')::boolean, FALSE) THEN
        v_success := v_success + 1;
        v_item_status := CASE WHEN v_unassign THEN 'unassigned' ELSE 'assigned' END;
      ELSE
        v_failure := v_failure + 1;
        v_item_status := 'failed';
        v_item_error := jsonb_build_object('code', 'assign_failed');
      END IF;
    EXCEPTION WHEN others THEN
      v_failure := v_failure + 1;
      v_item_status := 'failed';
      v_item_error := jsonb_build_object('code', 'assign_failed', 'message', SQLERRM, 'sqlstate', SQLSTATE);
    END;

    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'support_case_id', v_case_id,
      'ok', v_item_status IN ('assigned', 'unassigned', 'already_processed'),
      'status', v_item_status,
      'version', v_result->>'version',
      'error', v_item_error
    )));
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_failure = 0,
    'count', v_count,
    'success_count', v_success,
    'failure_count', v_failure,
    'already_processed_count', v_already,
    'correlation_id', v_correlation_id,
    'items', v_items
  );
END;
$function$;

COMMENT ON FUNCTION public.bulk_assign_support_cases_v1(JSONB)
  IS 'Bulk variant of assign_support_case_v1. Per-case isolation; envelope reports per-case status; capability-gated.';

REVOKE ALL ON FUNCTION public.bulk_assign_support_cases_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulk_assign_support_cases_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_assign_support_cases_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271223_bulk_assign_support_cases_v1'));
COMMIT;
