-- Spec-Issue: Phase B1 - Platform RPC contract: test_alert_rule_v1
-- Step: B1-RPC-6
-- Capability: alerts.read (read-only server-side eval; returns {pass, why})
--
-- Evaluates a JSONLogic-style trigger_conditions object against a sample
-- payload. Supports a minimal set of operators sufficient for FE evaluation
-- contract: { var, op, value } and { all, any } compounds. Server-side eval
-- is intentionally read-only and side-effect free.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280061_test_alert_rule_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.evaluate_alert_jsonlogic_v1(p_logic jsonb, p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_op TEXT;
  v_var TEXT;
  v_value JSONB;
  v_actual JSONB;
  v_pass BOOLEAN := FALSE;
  v_why TEXT := 'unknown';
  v_compound TEXT;
  v_arr JSONB;
  v_idx INT;
  v_sub JSONB;
  v_sub_eval JSONB;
  v_all_pass BOOLEAN := TRUE;
  v_any_pass BOOLEAN := FALSE;
BEGIN
  IF p_logic IS NULL OR jsonb_typeof(p_logic) <> 'object' THEN
    RETURN jsonb_build_object('pass', false, 'why', 'invalid_logic_shape');
  END IF;

  -- Compound: { all: [...] } or { any: [...] }
  IF p_logic ? 'all' THEN
    v_arr := p_logic->'all';
    IF jsonb_typeof(v_arr) <> 'array' THEN
      RETURN jsonb_build_object('pass', false, 'why', 'all_not_array');
    END IF;
    FOR v_idx IN 0 .. jsonb_array_length(v_arr) - 1 LOOP
      v_sub := v_arr->v_idx;
      v_sub_eval := public.evaluate_alert_jsonlogic_v1(v_sub, p_payload);
      IF NOT (v_sub_eval->>'pass')::boolean THEN
        v_all_pass := FALSE;
        EXIT;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('pass', v_all_pass, 'why', CASE WHEN v_all_pass THEN 'all_match' ELSE 'all_short_circuit' END);
  END IF;

  IF p_logic ? 'any' THEN
    v_arr := p_logic->'any';
    IF jsonb_typeof(v_arr) <> 'array' THEN
      RETURN jsonb_build_object('pass', false, 'why', 'any_not_array');
    END IF;
    FOR v_idx IN 0 .. jsonb_array_length(v_arr) - 1 LOOP
      v_sub := v_arr->v_idx;
      v_sub_eval := public.evaluate_alert_jsonlogic_v1(v_sub, p_payload);
      IF (v_sub_eval->>'pass')::boolean THEN
        v_any_pass := TRUE;
        EXIT;
      END IF;
    END LOOP;
    RETURN jsonb_build_object('pass', v_any_pass, 'why', CASE WHEN v_any_pass THEN 'any_match' ELSE 'any_no_match' END);
  END IF;

  -- Atomic: { var, op, value }
  v_var := p_logic->>'var';
  v_op := p_logic->>'op';
  v_value := p_logic->'value';

  IF v_var IS NULL OR v_op IS NULL THEN
    RETURN jsonb_build_object('pass', false, 'why', 'missing_var_or_op');
  END IF;

  v_actual := p_payload->v_var;

  CASE v_op
    WHEN '==' THEN v_pass := v_actual = v_value;
    WHEN '!=' THEN v_pass := v_actual <> v_value;
    WHEN '>' THEN v_pass := (v_actual::text)::numeric > (v_value::text)::numeric;
    WHEN '<' THEN v_pass := (v_actual::text)::numeric < (v_value::text)::numeric;
    WHEN '>=' THEN v_pass := (v_actual::text)::numeric >= (v_value::text)::numeric;
    WHEN '<=' THEN v_pass := (v_actual::text)::numeric <= (v_value::text)::numeric;
    WHEN 'in' THEN
      IF jsonb_typeof(v_value) = 'array' THEN
        v_pass := v_value @> jsonb_build_array(v_actual);
      ELSE
        v_pass := FALSE;
      END IF;
    WHEN 'exists' THEN v_pass := v_actual IS NOT NULL;
    ELSE v_pass := FALSE;
  END CASE;

  v_why := CASE WHEN v_pass THEN 'match' ELSE 'no_match' END;

  RETURN jsonb_build_object(
    'pass', v_pass,
    'why', v_why,
    'op', v_op,
    'var', v_var,
    'actual', v_actual,
    'expected', v_value
  );
EXCEPTION
  WHEN OTHERS THEN
    RETURN jsonb_build_object('pass', false, 'why', 'eval_error', 'detail', SQLERRM);
END;
$$;

REVOKE ALL ON FUNCTION public.evaluate_alert_jsonlogic_v1(jsonb, jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.evaluate_alert_jsonlogic_v1(jsonb, jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.evaluate_alert_jsonlogic_v1(jsonb, jsonb) TO service_role;

CREATE OR REPLACE FUNCTION public.test_alert_rule_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_logic JSONB := COALESCE(p_args->'trigger_conditions', NULL);
  v_payload JSONB := COALESCE(p_args->'sample_payload', '{}'::jsonb);
  v_eval JSONB;
  v_rule_id UUID := NULLIF(p_args->>'alert_rule_id', '')::uuid;
  v_rule public.alert_rules%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'test_alert_rule_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('alerts.read');

  -- If alert_rule_id provided, hydrate trigger_conditions from canonical row
  IF v_rule_id IS NOT NULL THEN
    SELECT * INTO v_rule
      FROM public.alert_rules
     WHERE id = v_rule_id
       AND deleted_at IS NULL;

    IF v_rule.id IS NULL THEN
      RAISE EXCEPTION 'test_alert_rule_v1 alert_rule_id % not found', v_rule_id
        USING ERRCODE = '23503';
    END IF;

    v_logic := v_rule.trigger_conditions;
  END IF;

  IF v_logic IS NULL OR jsonb_typeof(v_logic) <> 'object' THEN
    RAISE EXCEPTION 'test_alert_rule_v1 requires trigger_conditions object or alert_rule_id'
      USING ERRCODE = '22023';
  END IF;

  v_eval := public.evaluate_alert_jsonlogic_v1(v_logic, v_payload);

  RETURN jsonb_build_object(
    'ok', true,
    'pass', COALESCE((v_eval->>'pass')::boolean, FALSE),
    'why', v_eval->>'why',
    'evaluation', v_eval,
    'correlation_id', v_correlation_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.test_alert_rule_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.test_alert_rule_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.test_alert_rule_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.test_alert_rule_v1(jsonb)
  IS 'Read-only RPC: evaluate trigger_conditions JSONLogic against sample_payload; returns {pass, why}. Capability: alerts.read.';

SELECT pg_advisory_unlock(hashtext('202604280061_test_alert_rule_v1'));
COMMIT;
