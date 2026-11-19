-- Spec-Issue: Phase B1 - Platform RPC contract: bulk_toggle_feature_flags_v1
-- Step: B1-RPC-13
-- Capability: feature_flags.write
-- Returns per-flag result array; partial-success semantics.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280130_bulk_toggle_feature_flags_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.bulk_toggle_feature_flags_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_flags JSONB := COALESCE(p_args->'flags', '[]'::jsonb);
  v_default_enabled BOOLEAN := NULLIF(p_args->>'enabled', '')::boolean;
  v_results JSONB := '[]'::jsonb;
  v_idx INT;
  v_entry JSONB;
  v_flag_args JSONB;
  v_result JSONB;
  v_success_count INT := 0;
  v_error_count INT := 0;
  v_err_text TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bulk_toggle_feature_flags_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('feature_flags.write');

  IF jsonb_typeof(v_flags) <> 'array' OR jsonb_array_length(v_flags) = 0 THEN
    RAISE EXCEPTION 'bulk_toggle_feature_flags_v1 requires flags array'
      USING ERRCODE = '23502';
  END IF;

  FOR v_idx IN 0 .. jsonb_array_length(v_flags) - 1 LOOP
    v_entry := v_flags->v_idx;

    v_flag_args := jsonb_build_object(
      'feature_flag_id', NULLIF(v_entry->>'feature_flag_id', ''),
      'name', NULLIF(v_entry->>'name', ''),
      'enabled', COALESCE(NULLIF(v_entry->>'enabled', '')::boolean, v_default_enabled),
      'reason', NULLIF(v_entry->>'reason', '')
    );

    BEGIN
      v_result := public.toggle_feature_flag_v1(v_flag_args);
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_idx,
        'ok', true,
        'feature_flag_id', v_result->'feature_flag_id',
        'enabled', v_result->'enabled',
        'idempotent', v_result->'idempotent',
        'correlation_id', v_result->'correlation_id'
      ));
      v_success_count := v_success_count + 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_err_text := SQLERRM;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'index', v_idx,
          'ok', false,
          'feature_flag_id', NULLIF(v_entry->>'feature_flag_id', ''),
          'name', NULLIF(v_entry->>'name', ''),
          'error', v_err_text,
          'sqlstate', SQLSTATE
        ));
        v_error_count := v_error_count + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_error_count = 0,
    'success_count', v_success_count,
    'error_count', v_error_count,
    'results', v_results,
    'correlation_id', v_correlation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.bulk_toggle_feature_flags_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.bulk_toggle_feature_flags_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.bulk_toggle_feature_flags_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.bulk_toggle_feature_flags_v1(jsonb)
  IS 'Canonical write RPC: bulk feature_flag toggles via per-row toggle_feature_flag_v1; returns per-flag result array. Capability: feature_flags.write.';

SELECT pg_advisory_unlock(hashtext('202604280130_bulk_toggle_feature_flags_v1'));
COMMIT;
