-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: pricing_policy match extensions v2 (schema contract + matcher hardening)
-- Date: 2026-01-28
--
-- Goals:
--   - Expand pricing_policy rule matching (still row-driven, no hardcoding):
--       * box_count_min / box_count_max
--       * cod_amount_min / cod_amount_max
--   - Introduce schema_registry v2 documenting the extended match contract.
--   - Keep compute_pricing_quote_v1 backward compatible (unknown fields ignored).

BEGIN;
SELECT pg_advisory_lock(hashtext('202601282200_pricing_policy_match_ext_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) schema_registry v2 for pricing_policy (additive; backwards compatible)
-------------------------------------------------------------------------------

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'pricing_policy',
  2,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Pricing Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "currency": { "type": ["string", "null"] },
      "rounding": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "decimals": { "type": ["integer", "null"], "minimum": 0, "maximum": 6 }
        }
      },
      "rules": {
        "type": ["array", "null"],
        "items": {
          "type": "object",
          "additionalProperties": true,
          "properties": {
            "priority": { "type": ["integer", "null"], "minimum": 0 },
            "is_active": { "type": ["boolean", "null"] },
            "match": {
              "type": ["object", "null"],
              "additionalProperties": true,
              "properties": {
                "service_type": { "type": ["string", "null"] },
                "service_level": { "type": ["string", "null"] },
                "zone_id": { "type": ["string", "null"] },
                "distance_km_min": { "type": ["number", "null"], "minimum": 0 },
                "distance_km_max": { "type": ["number", "null"], "minimum": 0 },
                "box_count_min": { "type": ["integer", "null"], "minimum": 0 },
                "box_count_max": { "type": ["integer", "null"], "minimum": 0 },
                "cod_amount_min": { "type": ["number", "null"], "minimum": 0 },
                "cod_amount_max": { "type": ["number", "null"], "minimum": 0 }
              }
            },
            "components": {
              "type": ["array", "null"],
              "items": {
                "type": "object",
                "additionalProperties": true,
                "properties": {
                  "type": { "type": "string" },
                  "amount": { "type": ["number", "null"] }
                },
                "required": ["type"]
              }
            },
            "min_total": { "type": ["number", "null"], "minimum": 0 },
            "max_total": { "type": ["number", "null"], "minimum": 0 }
          }
        }
      }
    }
  }'::jsonb,
  'Pricing policy v2: adds match constraints for box_count and cod_amount to enable tiered agreements (still ladder-resolved; still rule-driven).',
  '[
    {
      "version": 2,
      "enabled": true,
      "currency": "SAR",
      "rounding": { "decimals": 2 },
      "rules": [
        {
          "priority": 100,
          "is_active": true,
          "match": { "service_type": "delivery", "box_count_min": 2, "cod_amount_min": 0.01 },
          "components": [
            { "type": "flat", "amount": 10 },
            { "type": "box_count", "amount": 2 },
            { "type": "cod_pct", "amount": 5 }
          ],
          "min_total": 10
        }
      ]
    }
  ]'::jsonb,
  TRUE
)
ON CONFLICT (category, version) DO NOTHING;

-------------------------------------------------------------------------------
-- 2) Quote computation helper: add rule match filters (box_count/cod_amount)
-------------------------------------------------------------------------------

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
      v_min_boxes INT := NULL;
      v_max_boxes INT := NULL;
      v_min_cod NUMERIC := NULL;
      v_max_cod NUMERIC := NULL;
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

      BEGIN v_min_boxes := NULLIF(v_match->>'box_count_min', '')::INT; EXCEPTION WHEN others THEN v_min_boxes := NULL; END;
      BEGIN v_max_boxes := NULLIF(v_match->>'box_count_max', '')::INT; EXCEPTION WHEN others THEN v_max_boxes := NULL; END;

      IF v_min_boxes IS NOT NULL AND (v_box_count IS NULL OR v_box_count < v_min_boxes) THEN
        v_match_ok := FALSE;
      END IF;
      IF v_max_boxes IS NOT NULL AND (v_box_count IS NULL OR v_box_count > v_max_boxes) THEN
        v_match_ok := FALSE;
      END IF;

      BEGIN v_min_cod := NULLIF(v_match->>'cod_amount_min', '')::NUMERIC; EXCEPTION WHEN others THEN v_min_cod := NULL; END;
      BEGIN v_max_cod := NULLIF(v_match->>'cod_amount_max', '')::NUMERIC; EXCEPTION WHEN others THEN v_max_cod := NULL; END;

      IF v_min_cod IS NOT NULL AND (v_cod_amount IS NULL OR v_cod_amount < v_min_cod) THEN
        v_match_ok := FALSE;
      END IF;
      IF v_max_cod IS NOT NULL AND (v_cod_amount IS NULL OR v_cod_amount > v_max_cod) THEN
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

    IF v_component_type IS NULL THEN
      CONTINUE;
    END IF;

    v_component_value := NULL;

    IF v_component_type = 'flat' THEN
      v_component_value := COALESCE(v_component_amount, 0);
    ELSIF v_component_type = 'distance_km' THEN
      v_component_value := COALESCE(v_component_amount, 0) * COALESCE(v_distance_km, 0);
    ELSIF v_component_type = 'box_count' THEN
      v_component_value := COALESCE(v_component_amount, 0) * COALESCE(v_box_count, 1);
    ELSIF v_component_type = 'cod_pct' THEN
      v_component_value := (COALESCE(v_component_amount, 0) / 100) * COALESCE(v_cod_amount, 0);
    ELSE
      -- Unknown component types are ignored (forward compatible).
      CONTINUE;
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

COMMENT ON FUNCTION public.compute_pricing_quote_v1(JSONB, JSONB) IS
  'Compute a pricing quote using a pricing_policy rule set and an input context. Rule matching supports service_type/service_level/zone_id/distance_km plus box_count and cod_amount constraints; components support flat/distance_km/box_count/cod_pct. Returns currency, total, breakdown, debug.';

SELECT pg_advisory_unlock(hashtext('202601282200_pricing_policy_match_ext_v2'));
COMMIT;

