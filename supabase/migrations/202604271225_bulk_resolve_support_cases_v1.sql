-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: bulk_resolve_support_cases_v1
-- Date: 2026-04-27
--
-- Purpose:
--   Bulk variant of resolve_support_case_v1. Per-case isolation; envelope reports per-case status.
--
-- Args (jsonb p_args):
--   support_case_ids   uuid[] (required, non-empty)
--   resolution         text (optional; applied per-case)
--   close              boolean (optional; default false)
--   correlation_id     uuid (optional)
--
-- Returns:
--   { ok, count, success_count, failure_count, already_processed_count, items: [...] }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271225_bulk_resolve_support_cases_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.bulk_resolve_support_cases_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_ids JSONB;
  v_id_text TEXT;
  v_case_id UUID;
  v_resolution TEXT;
  v_close BOOLEAN;
  v_correlation_id UUID;
  v_result JSONB;
  v_items JSONB := '[]'::jsonb;
  v_count INT := 0;
  v_success INT := 0;
  v_failure INT := 0;
  v_already INT := 0;
  v_item_status TEXT;
  v_item_error JSONB;
BEGIN
  PERFORM public.assert_capability_v1('support.write');
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bulk_resolve_support_cases_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_ids := COALESCE(v_args->'support_case_ids', '[]'::jsonb);
  IF jsonb_typeof(v_ids) IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'bulk_resolve_support_cases_v1 requires support_case_ids array'
      USING ERRCODE = '23502';
  END IF;
  IF jsonb_array_length(v_ids) = 0 THEN
    RAISE EXCEPTION 'bulk_resolve_support_cases_v1: support_case_ids must be non-empty'
      USING ERRCODE = '23514';
  END IF;

  v_resolution := NULLIF(btrim(COALESCE(v_args->>'resolution', '')), '');
  v_close := COALESCE((v_args->>'close')::boolean, FALSE);

  BEGIN v_correlation_id := NULLIF(v_args->>'correlation_id', '')::UUID;
  EXCEPTION WHEN others THEN v_correlation_id := NULL; END;
  IF v_correlation_id IS NULL THEN v_correlation_id := gen_random_uuid(); END IF;

  FOR v_id_text IN SELECT jsonb_array_elements_text(v_ids) LOOP
    v_count := v_count + 1;
    v_item_status := NULL;
    v_item_error := NULL;
    BEGIN
      v_case_id := NULLIF(btrim(v_id_text), '')::UUID;
    EXCEPTION WHEN others THEN
      v_failure := v_failure + 1;
      v_items := v_items || jsonb_build_array(jsonb_build_object(
        'ok', FALSE,
        'support_case_id', NULL,
        'status', 'invalid_id',
        'error', jsonb_build_object('code', 'invalid_support_case_id', 'value', v_id_text)
      ));
      CONTINUE;
    END;

    BEGIN
      v_result := public.resolve_support_case_v1(jsonb_strip_nulls(jsonb_build_object(
        'support_case_id', v_case_id,
        'resolution', v_resolution,
        'close', v_close,
        'correlation_id', v_correlation_id
      )));

      IF COALESCE((v_result->>'already_processed')::boolean, FALSE) THEN
        v_already := v_already + 1;
        v_item_status := 'already_processed';
      ELSIF COALESCE((v_result->>'ok')::boolean, FALSE) THEN
        v_success := v_success + 1;
        v_item_status := COALESCE(v_result->>'status', CASE WHEN v_close THEN 'closed' ELSE 'resolved' END);
      ELSE
        v_failure := v_failure + 1;
        v_item_status := 'failed';
        v_item_error := jsonb_build_object('code', 'resolve_failed');
      END IF;
    EXCEPTION WHEN others THEN
      v_failure := v_failure + 1;
      v_item_status := 'failed';
      v_item_error := jsonb_build_object('code', 'resolve_failed', 'message', SQLERRM, 'sqlstate', SQLSTATE);
    END;

    v_items := v_items || jsonb_build_array(jsonb_strip_nulls(jsonb_build_object(
      'support_case_id', v_case_id,
      'ok', v_item_status IN ('resolved', 'closed', 'already_processed'),
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

COMMENT ON FUNCTION public.bulk_resolve_support_cases_v1(JSONB)
  IS 'Bulk variant of resolve_support_case_v1. Per-case isolation; envelope reports per-case status; capability-gated.';

REVOKE ALL ON FUNCTION public.bulk_resolve_support_cases_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bulk_resolve_support_cases_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.bulk_resolve_support_cases_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604271225_bulk_resolve_support_cases_v1'));
COMMIT;
