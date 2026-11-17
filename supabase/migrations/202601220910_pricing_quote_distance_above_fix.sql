-- Plan: PLAN-202601-cod-settlements-reconciliation / Step: S04
-- Migration: Fix pricing quote distance_km_above component scope
-- Date: 2026-01-22
--
-- Notes:
--   - Prior migration introduced distance_km_above but referenced a nested-block variable out of scope.
--   - This migration is a fixup: redefines compute_pricing_quote_v1 with correct scoping.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601220910_pricing_quote_distance_above_fix'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.compute_pricing_quote_v1(
  p_context JSONB,
  p_policy JSONB
)
RETURNS TABLE (
  currency TEXT,
  total_amount NUMERIC,
  breakdown JSONB,
  debug JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_rules JSONB := COALESCE(v_policy->'rules', '[]'::jsonb);
  v_currency TEXT := COALESCE(NULLIF(v_policy->>'currency', ''), 'SAR');
  v_decimals INT := 2;

  v_service_type TEXT := NULLIF(v_context->>'service_type', '');
  v_service_level TEXT := NULLIF(v_context->>'service_level', '');
  v_zone_id UUID := NULL;
  v_distance_km NUMERIC := NULL;
  v_box_count INT := NULL;
  v_cod_amount NUMERIC := NULL;

  v_best_rule JSONB := NULL;
  v_best_idx INT := NULL;
  v_best_priority INT := -1;

  v_rule RECORD;
  v_match JSONB;
  v_components JSONB;
  v_component JSONB;

  v_component_type TEXT;
  v_component_amount NUMERIC;
  v_component_value NUMERIC;
  v_component_min NUMERIC;
  v_component_max NUMERIC;

  v_total NUMERIC := 0;
  v_min_total NUMERIC := NULL;
  v_max_total NUMERIC := NULL;
  v_out_breakdown JSONB := '[]'::jsonb;
BEGIN
  IF jsonb_typeof(v_policy) <> 'object' THEN
    v_policy := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_context) <> 'object' THEN
    v_context := '{}'::jsonb;
  END IF;

  BEGIN v_decimals := COALESCE(NULLIF((v_policy #>> '{rounding,decimals}'), '')::INT, 2); EXCEPTION WHEN others THEN v_decimals := 2; END;

  IF COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE) IS NOT TRUE THEN
    RETURN QUERY
    SELECT v_currency, NULL::NUMERIC, '[]'::jsonb, jsonb_build_object('status', 'disabled');
    RETURN;
  END IF;

  BEGIN v_zone_id := NULLIF(v_context->>'zone_id', '')::UUID; EXCEPTION WHEN others THEN v_zone_id := NULL; END;
  BEGIN v_distance_km := NULLIF(v_context->>'distance_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_distance_km := NULL; END;
  BEGIN v_box_count := NULLIF(v_context->>'box_count', '')::INT; EXCEPTION WHEN others THEN v_box_count := NULL; END;
  BEGIN v_cod_amount := NULLIF(v_context->>'cod_amount', '')::NUMERIC; EXCEPTION WHEN others THEN v_cod_amount := NULL; END;

  IF jsonb_typeof(v_rules) <> 'array' THEN
    v_rules := '[]'::jsonb;
  END IF;

  FOR v_rule IN
    SELECT value AS rule, ordinality AS idx
    FROM jsonb_array_elements(v_rules) WITH ORDINALITY
  LOOP
    DECLARE
      v_priority INT := 0;
      v_active BOOLEAN := TRUE;
      v_match_ok BOOLEAN := TRUE;
      v_zone_text TEXT := NULL;
      v_min_km NUMERIC := NULL;
      v_max_km NUMERIC := NULL;
    BEGIN
      BEGIN v_priority := COALESCE(NULLIF((v_rule.rule->>'priority'), '')::INT, 0); EXCEPTION WHEN others THEN v_priority := 0; END;
      BEGIN v_active := COALESCE((v_rule.rule->>'is_active')::BOOLEAN, TRUE); EXCEPTION WHEN others THEN v_active := TRUE; END;
      IF v_active IS NOT TRUE THEN
        CONTINUE;
      END IF;

      v_match := COALESCE(v_rule.rule->'match', '{}'::jsonb);
      IF jsonb_typeof(v_match) <> 'object' THEN
        v_match := '{}'::jsonb;
      END IF;

      IF NULLIF(v_match->>'service_type', '') IS NOT NULL AND NULLIF(v_match->>'service_type', '') IS DISTINCT FROM v_service_type THEN
        v_match_ok := FALSE;
      END IF;
      IF NULLIF(v_match->>'service_level', '') IS NOT NULL AND NULLIF(v_match->>'service_level', '') IS DISTINCT FROM v_service_level THEN
        v_match_ok := FALSE;
      END IF;

      v_zone_text := NULLIF(v_match->>'zone_id', '');
      IF v_zone_text IS NOT NULL THEN
        IF v_zone_id IS NULL OR v_zone_text IS DISTINCT FROM v_zone_id::text THEN
          v_match_ok := FALSE;
        END IF;
      END IF;

      BEGIN v_min_km := NULLIF(v_match->>'distance_km_min', '')::NUMERIC; EXCEPTION WHEN others THEN v_min_km := NULL; END;
      BEGIN v_max_km := NULLIF(v_match->>'distance_km_max', '')::NUMERIC; EXCEPTION WHEN others THEN v_max_km := NULL; END;

      IF v_min_km IS NOT NULL AND (v_distance_km IS NULL OR v_distance_km < v_min_km) THEN
        v_match_ok := FALSE;
      END IF;
      IF v_max_km IS NOT NULL AND (v_distance_km IS NULL OR v_distance_km > v_max_km) THEN
        v_match_ok := FALSE;
      END IF;

      IF v_match_ok IS NOT TRUE THEN
        CONTINUE;
      END IF;

      IF v_priority > v_best_priority THEN
        v_best_rule := v_rule.rule;
        v_best_idx := v_rule.idx;
        v_best_priority := v_priority;
      END IF;
    END;
  END LOOP;

  IF v_best_rule IS NULL THEN
    RETURN QUERY
    SELECT v_currency, NULL::NUMERIC, '[]'::jsonb, jsonb_build_object('status', 'no_match');
    RETURN;
  END IF;

  v_components := COALESCE(v_best_rule->'components', '[]'::jsonb);
  IF jsonb_typeof(v_components) <> 'array' THEN
    v_components := '[]'::jsonb;
  END IF;

  BEGIN v_min_total := NULLIF(v_best_rule->>'min_total', '')::NUMERIC; EXCEPTION WHEN others THEN v_min_total := NULL; END;
  BEGIN v_max_total := NULLIF(v_best_rule->>'max_total', '')::NUMERIC; EXCEPTION WHEN others THEN v_max_total := NULL; END;

  v_total := 0;
  v_out_breakdown := '[]'::jsonb;

  FOR v_component IN SELECT value FROM jsonb_array_elements(v_components)
  LOOP
    v_component_type := NULLIF(v_component->>'type', '');
    BEGIN v_component_amount := NULLIF(v_component->>'amount', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_amount := NULL; END;
    BEGIN v_component_min := NULLIF(v_component->>'min_value', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_min := NULL; END;
    BEGIN v_component_max := NULLIF(v_component->>'max_value', '')::NUMERIC; EXCEPTION WHEN others THEN v_component_max := NULL; END;

    IF v_component_type IS NULL THEN
      CONTINUE;
    END IF;

    v_component_value := NULL;

    IF v_component_type = 'flat' THEN
      v_component_value := COALESCE(v_component_amount, 0);
    ELSIF v_component_type = 'distance_km' THEN
      v_component_value := COALESCE(v_component_amount, 0) * GREATEST(COALESCE(v_distance_km, 0), 0);
    ELSIF v_component_type = 'distance_km_above' THEN
      DECLARE v_threshold_km NUMERIC := NULL;
      BEGIN
        BEGIN v_threshold_km := NULLIF(v_component->>'threshold_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_threshold_km := NULL; END;
        v_component_value := COALESCE(v_component_amount, 0) * GREATEST(GREATEST(COALESCE(v_distance_km, 0), 0) - COALESCE(v_threshold_km, 0), 0);
      END;
    ELSIF v_component_type = 'distance_km_band' THEN
      DECLARE
        v_band_min NUMERIC := NULL;
        v_band_max NUMERIC := NULL;
        v_band_km NUMERIC := 0;
        v_dist NUMERIC := GREATEST(COALESCE(v_distance_km, 0), 0);
      BEGIN
        BEGIN v_band_min := NULLIF(v_component->>'min_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_band_min := NULL; END;
        BEGIN v_band_max := NULLIF(v_component->>'max_km', '')::NUMERIC; EXCEPTION WHEN others THEN v_band_max := NULL; END;
        v_band_km := GREATEST(LEAST(v_dist, COALESCE(v_band_max, v_dist)) - COALESCE(v_band_min, 0), 0);
        v_component_value := COALESCE(v_component_amount, 0) * v_band_km;
      END;
    ELSIF v_component_type = 'box_count' THEN
      v_component_value := COALESCE(v_component_amount, 0) * COALESCE(v_box_count, 1);
    ELSIF v_component_type = 'cod_pct' THEN
      v_component_value := CASE
        WHEN GREATEST(COALESCE(v_cod_amount, 0), 0) > 0
          THEN (COALESCE(v_component_amount, 0) / 100) * GREATEST(COALESCE(v_cod_amount, 0), 0)
        ELSE 0
      END;
    ELSIF v_component_type = 'cod_flat' THEN
      v_component_value := CASE WHEN GREATEST(COALESCE(v_cod_amount, 0), 0) > 0 THEN COALESCE(v_component_amount, 0) ELSE 0 END;
    ELSE
      CONTINUE;
    END IF;

    IF v_component_value IS NOT NULL THEN
      IF v_component_type LIKE 'cod_%' AND GREATEST(COALESCE(v_cod_amount, 0), 0) <= 0 THEN
        NULL;
      ELSE
        IF v_component_min IS NOT NULL THEN
          v_component_value := GREATEST(v_component_value, v_component_min);
        END IF;
        IF v_component_max IS NOT NULL THEN
          v_component_value := LEAST(v_component_value, v_component_max);
        END IF;
      END IF;
    END IF;

    v_total := v_total + COALESCE(v_component_value, 0);

    v_out_breakdown := v_out_breakdown || jsonb_build_array(
      jsonb_build_object(
        'type', v_component_type,
        'amount', v_component_amount,
        'value', v_component_value
      )
    );
  END LOOP;

  IF v_min_total IS NOT NULL THEN
    v_total := GREATEST(v_total, v_min_total);
  END IF;
  IF v_max_total IS NOT NULL THEN
    v_total := LEAST(v_total, v_max_total);
  END IF;

  v_total := round(v_total, v_decimals);

  RETURN QUERY
  SELECT
    v_currency,
    v_total,
    v_out_breakdown,
    jsonb_build_object(
      'status', 'priced',
      'rule_index', v_best_idx,
      'rule_priority', v_best_priority
    );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202601220910_pricing_quote_distance_above_fix'));
COMMIT;

