-- Plan: PLAN-202601-commercial-agreements-pricing-policy / Step: S04
-- Migration: Commercial agreements - pricing_policy foundation (schema + defaults + resolvers)
-- Date: 2026-01-21
--
-- Goals:
--   - Introduce `pricing_policy` as a ladder-resolved settings category (Global < Tenant < Client < Sender < Source/Resource).
--   - Provide a reusable quote computation helper (`compute_pricing_quote_v1`) that is configuration-driven (no hardcoding).
--   - Seed safe global defaults and keep all behavior row-driven.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601212820_pricing_policy_foundation'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) pricing_policy: category registry metadata + schema contract
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes,
  resource_scope_rel
)
VALUES (
  'pricing_policy',
  'Commercial pricing policy (rate rules) for tenant/client/sender agreements; used for quotes and later finance events.',
  TRUE,
  TRUE,
  FALSE,
  'skip',
  '["global","tenant","client","sender","source","resource"]'::jsonb,
  'public.branches'::regclass
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  resource_scope_rel = EXCLUDED.resource_scope_rel,
  updated_at = now();

INSERT INTO public.schema_registry (category, version, schema, description, examples, is_active)
VALUES (
  'pricing_policy',
  1,
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
                "distance_km_max": { "type": ["number", "null"], "minimum": 0 }
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
  'Commercial pricing policy resolved via settings ladder; rule-driven quote computation supports coverage-based and distance-based models.',
  '[
    {
      "version": 1,
      "enabled": true,
      "currency": "SAR",
      "rounding": { "decimals": 2 },
      "rules": [
        {
          "priority": 100,
          "is_active": true,
          "match": { "service_type": "delivery" },
          "components": [
            { "type": "flat", "amount": 10 },
            { "type": "distance_km", "amount": 2 }
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
-- 2) Seed global default (safe: empty rules => unpriced until configured)
-------------------------------------------------------------------------------

WITH upsert AS (
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', true,
    'currency', 'SAR',
    'rounding', jsonb_build_object('decimals', 2),
    'rules', jsonb_build_array()
  ) AS body
)
INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, schema_version, approved_at)
SELECT 'pricing_policy', 'global', NULL, 1, body, 1, now()
FROM upsert
ON CONFLICT DO NOTHING;

INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
FROM public.settings_versions sv
WHERE sv.category = 'pricing_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.settings s
    WHERE s.category = sv.category
      AND s.scope_type = sv.scope_type
      AND s.scope_id IS NULL
  );

-------------------------------------------------------------------------------
-- 3) Resolver: pricing_policy (ladder + scope_path)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.resolve_pricing_policy(
  p_context JSONB
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_resource_id UUID := NULL;
  v_source_id UUID := NULL;
  v_sender_id UUID := NULL;
  v_client_id UUID := NULL;
  v_org_id UUID := NULL;
  v_scope_path JSONB := '[]'::jsonb;
BEGIN
  IF p_context IS NULL OR jsonb_typeof(p_context) <> 'object' THEN
    RETURN QUERY
    SELECT * FROM public.resolve_settings_row('pricing_policy', 'global', NULL) LIMIT 1;
    RETURN;
  END IF;

  BEGIN v_resource_id := NULLIF(p_context->>'resource_id', '')::UUID; EXCEPTION WHEN others THEN v_resource_id := NULL; END;
  BEGIN v_source_id := NULLIF(p_context->>'webhook_source_id', '')::UUID; EXCEPTION WHEN others THEN v_source_id := NULL; END;
  BEGIN v_sender_id := NULLIF(p_context->>'sender_id', '')::UUID; EXCEPTION WHEN others THEN v_sender_id := NULL; END;
  BEGIN v_client_id := NULLIF(p_context->>'client_id', '')::UUID; EXCEPTION WHEN others THEN v_client_id := NULL; END;
  BEGIN v_org_id := NULLIF(p_context->>'organization_id', '')::UUID; EXCEPTION WHEN others THEN v_org_id := NULL; END;

  -- Derive chain when higher context is not provided.
  IF v_source_id IS NOT NULL AND v_sender_id IS NULL THEN
    SELECT ws.sender_id, ws.organization_id
      INTO v_sender_id, v_org_id
      FROM public.webhook_sources ws
     WHERE ws.id = v_source_id;
  END IF;

  IF v_sender_id IS NOT NULL AND v_client_id IS NULL THEN
    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_sender_id;
  END IF;

  IF v_client_id IS NOT NULL AND v_org_id IS NULL THEN
    SELECT c.organization_id
      INTO v_org_id
      FROM public.clients c
     WHERE c.id = v_client_id;
  END IF;

  IF v_resource_id IS NOT NULL AND v_org_id IS NULL THEN
    SELECT b.organization_id
      INTO v_org_id
      FROM public.branches b
     WHERE b.id = v_resource_id;
  END IF;

  -- Build evaluated scope path (highest precedence -> lowest).
  IF v_resource_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'resource', 'scope_id', v_resource_id));
  END IF;
  IF v_source_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'source', 'scope_id', v_source_id));
  END IF;
  IF v_sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'sender', 'scope_id', v_sender_id));
  END IF;
  IF v_client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'client', 'scope_id', v_client_id));
  END IF;
  IF v_org_id IS NOT NULL THEN
    v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'tenant', 'scope_id', v_org_id));
  END IF;
  v_scope_path := v_scope_path || jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL));

  RETURN QUERY
  SELECT ranked.id, ranked.settings_version_id, ranked.scope_type, ranked.scope_id, ranked.cached_value, ranked.version, v_scope_path
  FROM (
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 1 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_resource_id IS NOT NULL
       AND s.category = 'pricing_policy'
       AND s.scope_type = 'resource'
       AND s.scope_id = v_resource_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 2 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_source_id IS NOT NULL
       AND s.category = 'pricing_policy'
       AND s.scope_type = 'source'
       AND s.scope_id = v_source_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 3 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_sender_id IS NOT NULL
       AND s.category = 'pricing_policy'
       AND s.scope_type = 'sender'
       AND s.scope_id = v_sender_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 4 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_client_id IS NOT NULL
       AND s.category = 'pricing_policy'
       AND s.scope_type = 'client'
       AND s.scope_id = v_client_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 5 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE v_org_id IS NOT NULL
       AND s.category = 'pricing_policy'
       AND s.scope_type = 'tenant'
       AND s.scope_id = v_org_id

    UNION ALL
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, s.cached_value, sv.version, 6 AS priority
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'pricing_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  ) ranked
  ORDER BY ranked.priority, ranked.id
  LIMIT 1;
END;
$function$;

COMMENT ON FUNCTION public.resolve_pricing_policy(JSONB) IS
  'Resolve pricing_policy with precedence: resource(branch) > source > sender > client > tenant > global; returns settings row + evaluated scope_path.';

-------------------------------------------------------------------------------
-- 4) Quote computation helper (pure; reusable; rule-driven)
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
  'Compute a pricing quote using a pricing_policy rule set and an input context (service_type/service_level/zone_id/distance_km/box_count/cod_amount). Returns currency, total, breakdown, debug.';

SELECT pg_advisory_unlock(hashtext('202601212820_pricing_policy_foundation'));
COMMIT;
