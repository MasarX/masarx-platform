-- Migration: Route plan constraint guards v1
-- Purpose:
--   - Add a route-plan-SSOT-first constraint validator for UC073.
--   - Enforce declared driver skill, vehicle skill, and capacity constraints
--     before freeze/apply without bypassing route_plans as the planning SSOT.
--   - Keep constraint interpretation row-driven through route_plan_constraint_policy.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604061140_route_plan_constraint_guards_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Row-driven route-plan constraint policy
-------------------------------------------------------------------------------

INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'route_plan_constraint_policy',
  'Declared driver skill, vehicle skill, and capacity constraints for route_plans before freeze/apply. Resolved through the scope ladder.',
  TRUE,
  TRUE,
  FALSE,
  'hard_fail',
  '["global","tenant","client","sender","source","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

CREATE OR REPLACE FUNCTION public.route_plan_constraint_policy_default_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'version', 1,
    'enabled', true,
    'assigned_driver_user_type', 'driver',
    'active_driver_statuses', jsonb_build_array('active'),
    'active_vehicle_statuses', jsonb_build_array('active'),
    'driver_skill_paths', jsonb_build_array(
      'metadata.skill_keys',
      'metadata.route.skill_keys',
      'metadata.route_planning.skill_keys'
    ),
    'vehicle_skill_paths', jsonb_build_array(
      'metadata.skill_keys',
      'metadata.route.skill_keys',
      'metadata.route_planning.skill_keys'
    ),
    'vehicle_capacity_paths', jsonb_build_array(
      'metadata.capacity',
      'metadata.route.capacity',
      'metadata.route_planning.capacity'
    ),
    'stop_driver_skill_paths', jsonb_build_array(
      'required_driver_skill_keys',
      'metadata.required_driver_skill_keys',
      'metadata.route.required_driver_skill_keys'
    ),
    'stop_vehicle_skill_paths', jsonb_build_array(
      'required_vehicle_skill_keys',
      'metadata.required_vehicle_skill_keys',
      'metadata.route.required_vehicle_skill_keys'
    ),
    'stop_capacity_paths', jsonb_build_array(
      'capacity_demand',
      'metadata.capacity_demand',
      'metadata.route.capacity_demand'
    ),
    'stop_count_capacity_key', 'shipments',
    'enforce_stop_count_capacity_default', false
  );
$function$;

COMMENT ON FUNCTION public.route_plan_constraint_policy_default_v1()
  IS 'Canonical default route-plan constraint policy for declared driver skill, vehicle skill, and capacity validation.';

REVOKE ALL ON FUNCTION public.route_plan_constraint_policy_default_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_constraint_policy_default_v1() FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_constraint_policy_default_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_constraint_policy_default_v1() TO service_role;

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
SELECT
  'route_plan_constraint_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Route Plan Constraint Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "enabled": { "type": ["boolean", "null"] },
      "assigned_driver_user_type": { "type": ["string", "null"] },
      "active_driver_statuses": { "type": ["array", "null"], "items": { "type": "string" } },
      "active_vehicle_statuses": { "type": ["array", "null"], "items": { "type": "string" } },
      "driver_skill_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "vehicle_skill_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "vehicle_capacity_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "stop_driver_skill_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "stop_vehicle_skill_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "stop_capacity_paths": { "type": ["array", "null"], "items": { "type": "string" } },
      "stop_count_capacity_key": { "type": ["string", "null"] },
      "enforce_stop_count_capacity_default": { "type": ["boolean", "null"] }
    }
  }'::jsonb,
  'Row-driven path policy for route-plan constraint validation before freeze/apply.',
  jsonb_build_array(public.route_plan_constraint_policy_default_v1()),
  TRUE
WHERE NOT EXISTS (
  SELECT 1
  FROM public.schema_registry sr
  WHERE sr.category = 'route_plan_constraint_policy'
    AND sr.version = 1
);

WITH default_policy AS (
  SELECT public.route_plan_constraint_policy_default_v1() AS value
)
INSERT INTO public.settings_versions (
  category,
  scope_type,
  scope_id,
  schema_version,
  value,
  version,
  created_at
)
SELECT
  'route_plan_constraint_policy',
  'global',
  NULL,
  1,
  dp.value,
  1,
  now()
FROM default_policy dp
WHERE NOT EXISTS (
  SELECT 1
  FROM public.settings_versions sv
  WHERE sv.category = 'route_plan_constraint_policy'
    AND sv.scope_type = 'global'
    AND sv.scope_id IS NULL
    AND sv.version = 1
);

INSERT INTO public.settings (
  category,
  scope_type,
  scope_id,
  settings_version_id,
  cached_value,
  last_updated
)
SELECT
  sv.category,
  sv.scope_type,
  sv.scope_id,
  sv.id,
  sv.value,
  now()
FROM public.settings_versions sv
WHERE sv.category = 'route_plan_constraint_policy'
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
-- 2) Constraint helper functions
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_text_array_v1(
  p_value JSONB
)
RETURNS TEXT[]
LANGUAGE sql
IMMUTABLE
AS $function$
  WITH normalized AS (
    SELECT lower(NULLIF(btrim(value), '')) AS item
    FROM (
      SELECT jsonb_array_elements_text(p_value) AS value
      WHERE jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) = 'array'
      UNION ALL
      SELECT trim(both '"' FROM p_value::text) AS value
      WHERE jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) = 'string'
    ) AS source
  )
  SELECT COALESCE(array_agg(DISTINCT item ORDER BY item), ARRAY[]::text[])
  FROM normalized
  WHERE item IS NOT NULL;
$function$;

COMMENT ON FUNCTION public.route_plan_text_array_v1(JSONB)
  IS 'Normalize JSONB string/array values into a unique lowercase text array for route-plan constraint validation.';

REVOKE ALL ON FUNCTION public.route_plan_text_array_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_text_array_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_text_array_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_text_array_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.route_plan_collect_text_set_v1(
  p_doc JSONB,
  p_paths TEXT[]
)
RETURNS TEXT[]
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_path TEXT;
  v_value JSONB := NULL;
  v_out TEXT[] := ARRAY[]::text[];
BEGIN
  IF p_doc IS NULL OR p_paths IS NULL OR array_length(p_paths, 1) IS NULL THEN
    RETURN ARRAY[]::text[];
  END IF;

  FOREACH v_path IN ARRAY p_paths LOOP
    IF NULLIF(btrim(COALESCE(v_path, '')), '') IS NULL THEN
      CONTINUE;
    END IF;

    v_value := public.route_plan_first_path_value_v1(p_doc, ARRAY[v_path]);
    IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
      CONTINUE;
    END IF;

    v_out := (
      SELECT COALESCE(array_agg(DISTINCT item ORDER BY item), ARRAY[]::text[])
      FROM (
        SELECT unnest(COALESCE(v_out, ARRAY[]::text[])) AS item
        UNION ALL
        SELECT unnest(public.route_plan_text_array_v1(v_value)) AS item
      ) AS merged
      WHERE item IS NOT NULL
    );
  END LOOP;

  RETURN COALESCE(v_out, ARRAY[]::text[]);
END;
$function$;

COMMENT ON FUNCTION public.route_plan_collect_text_set_v1(JSONB, TEXT[])
  IS 'Collect a unique lowercase text set from every configured path in a JSONB document.';

REVOKE ALL ON FUNCTION public.route_plan_collect_text_set_v1(JSONB, TEXT[]) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_collect_text_set_v1(JSONB, TEXT[]) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_collect_text_set_v1(JSONB, TEXT[]) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_collect_text_set_v1(JSONB, TEXT[]) TO service_role;

CREATE OR REPLACE FUNCTION public.route_plan_normalize_numeric_map_v1(
  p_value JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_entry RECORD;
  v_num NUMERIC := NULL;
  v_out JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(COALESCE(p_value, 'null'::jsonb)) IS DISTINCT FROM 'object' THEN
    RETURN '{}'::jsonb;
  END IF;

  FOR v_entry IN
    SELECT key, value
    FROM jsonb_each(p_value)
  LOOP
    BEGIN
      v_num := NULLIF(btrim(trim(both '"' FROM v_entry.value::text)), '')::NUMERIC;
    EXCEPTION
      WHEN others THEN
        v_num := NULL;
    END;

    IF v_num IS NULL OR v_num < 0 OR NULLIF(btrim(COALESCE(v_entry.key, '')), '') IS NULL THEN
      CONTINUE;
    END IF;

    v_out := jsonb_set(
      v_out,
      ARRAY[lower(btrim(v_entry.key))],
      to_jsonb(v_num),
      TRUE
    );
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.route_plan_normalize_numeric_map_v1(JSONB)
  IS 'Normalize JSONB numeric-object values into a lowercase-key numeric map for route-plan constraint validation.';

REVOKE ALL ON FUNCTION public.route_plan_normalize_numeric_map_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_normalize_numeric_map_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_normalize_numeric_map_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_normalize_numeric_map_v1(JSONB) TO service_role;

CREATE OR REPLACE FUNCTION public.route_plan_sum_numeric_maps_v1(
  p_left JSONB,
  p_right JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_left JSONB := public.route_plan_normalize_numeric_map_v1(COALESCE(p_left, '{}'::jsonb));
  v_right JSONB := public.route_plan_normalize_numeric_map_v1(COALESCE(p_right, '{}'::jsonb));
  v_key TEXT;
  v_left_num NUMERIC := 0;
  v_right_num NUMERIC := 0;
  v_out JSONB := '{}'::jsonb;
BEGIN
  FOR v_key IN
    SELECT key
    FROM (
      SELECT key FROM jsonb_each(v_left)
      UNION
      SELECT key FROM jsonb_each(v_right)
    ) AS unioned
    ORDER BY key
  LOOP
    BEGIN
      v_left_num := COALESCE(NULLIF(v_left->>v_key, '')::NUMERIC, 0);
    EXCEPTION
      WHEN others THEN
        v_left_num := 0;
    END;

    BEGIN
      v_right_num := COALESCE(NULLIF(v_right->>v_key, '')::NUMERIC, 0);
    EXCEPTION
      WHEN others THEN
        v_right_num := 0;
    END;

    v_out := jsonb_set(
      v_out,
      ARRAY[v_key],
      to_jsonb(v_left_num + v_right_num),
      TRUE
    );
  END LOOP;

  RETURN v_out;
END;
$function$;

COMMENT ON FUNCTION public.route_plan_sum_numeric_maps_v1(JSONB, JSONB)
  IS 'Add two normalized numeric maps together for route-plan capacity demand aggregation.';

REVOKE ALL ON FUNCTION public.route_plan_sum_numeric_maps_v1(JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_sum_numeric_maps_v1(JSONB, JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_sum_numeric_maps_v1(JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_sum_numeric_maps_v1(JSONB, JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 3) Constraint validator
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_plan_validate_constraints_v1(
  p_route_plan_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_plan public.route_plans%ROWTYPE;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_policy JSONB := '{}'::jsonb;
  v_enabled BOOLEAN := TRUE;
  v_assigned_driver_user_type TEXT := 'driver';
  v_stop_count_capacity_key TEXT := 'shipments';
  v_enforce_stop_count_capacity BOOLEAN := FALSE;

  v_driver_statuses TEXT[] := ARRAY['active']::text[];
  v_vehicle_statuses TEXT[] := ARRAY['active']::text[];
  v_driver_skill_paths TEXT[] := ARRAY['metadata.skill_keys', 'metadata.route.skill_keys', 'metadata.route_planning.skill_keys']::text[];
  v_vehicle_skill_paths TEXT[] := ARRAY['metadata.skill_keys', 'metadata.route.skill_keys', 'metadata.route_planning.skill_keys']::text[];
  v_vehicle_capacity_paths TEXT[] := ARRAY['metadata.capacity', 'metadata.route.capacity', 'metadata.route_planning.capacity']::text[];
  v_stop_driver_skill_paths TEXT[] := ARRAY['required_driver_skill_keys', 'metadata.required_driver_skill_keys', 'metadata.route.required_driver_skill_keys']::text[];
  v_stop_vehicle_skill_paths TEXT[] := ARRAY['required_vehicle_skill_keys', 'metadata.required_vehicle_skill_keys', 'metadata.route.required_vehicle_skill_keys']::text[];
  v_stop_capacity_paths TEXT[] := ARRAY['capacity_demand', 'metadata.capacity_demand', 'metadata.route.capacity_demand']::text[];

  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_driver public.users%ROWTYPE;
  v_driver_profile public.driver_profiles%ROWTYPE;
  v_vehicle public.vehicles%ROWTYPE;
  v_vehicle_type public.vehicle_types%ROWTYPE;

  v_stops JSONB := '[]'::jsonb;
  v_stop JSONB := '{}'::jsonb;
  v_stop_count INT := 0;

  v_driver_profile_doc JSONB := '{}'::jsonb;
  v_vehicle_profile_doc JSONB := '{}'::jsonb;
  v_capacity_value JSONB := '{}'::jsonb;

  v_driver_skill_keys TEXT[] := ARRAY[]::text[];
  v_vehicle_skill_keys TEXT[] := ARRAY[]::text[];
  v_required_driver_skill_keys TEXT[] := ARRAY[]::text[];
  v_required_vehicle_skill_keys TEXT[] := ARRAY[]::text[];
  v_missing_driver_skill_keys TEXT[] := ARRAY[]::text[];
  v_missing_vehicle_skill_keys TEXT[] := ARRAY[]::text[];

  v_capacity_demand JSONB := '{}'::jsonb;
  v_vehicle_capacity JSONB := '{}'::jsonb;
  v_violations JSONB := '[]'::jsonb;
  v_capacity_entry RECORD;
  v_capacity_limit NUMERIC := NULL;
  v_capacity_required NUMERIC := NULL;
  v_needs_driver_validation BOOLEAN := FALSE;
  v_needs_vehicle_validation BOOLEAN := FALSE;
BEGIN
  IF p_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'route_plan_validate_constraints_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = p_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'route_plan_validate_constraints_v1 route_plan % not found', p_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_policy_ctx := jsonb_build_object(
    'organization_id', v_plan.organization_id,
    'branch_id', v_plan.branch_id
  );

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_context('route_plan_constraint_policy', v_policy_ctx)
   LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_plan_validate_constraints_v1 missing route_plan_constraint_policy for organization %', v_plan.organization_id
      USING ERRCODE = 'P0001';
  END IF;

  v_policy := public.deep_merge_jsonb(
    public.route_plan_constraint_policy_default_v1(),
    COALESCE(v_policy_row.value, '{}'::jsonb)
  );

  BEGIN
    v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, TRUE);
  EXCEPTION
    WHEN others THEN
      v_enabled := TRUE;
  END;

  v_assigned_driver_user_type := lower(COALESCE(NULLIF(btrim(COALESCE(v_policy->>'assigned_driver_user_type', '')), ''), 'driver'));
  v_stop_count_capacity_key := lower(COALESCE(NULLIF(btrim(COALESCE(v_policy->>'stop_count_capacity_key', '')), ''), 'shipments'));

  BEGIN
    v_enforce_stop_count_capacity := COALESCE(
      (v_plan.constraints->>'enforce_stop_count_capacity')::BOOLEAN,
      (v_policy->>'enforce_stop_count_capacity_default')::BOOLEAN,
      FALSE
    );
  EXCEPTION
    WHEN others THEN
      v_enforce_stop_count_capacity := FALSE;
  END;

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_driver_statuses
         )
    INTO v_driver_statuses
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'active_driver_statuses', 'null'::jsonb)) = 'array' THEN v_policy->'active_driver_statuses'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_vehicle_statuses
         )
    INTO v_vehicle_statuses
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'active_vehicle_statuses', 'null'::jsonb)) = 'array' THEN v_policy->'active_vehicle_statuses'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_driver_skill_paths
         )
    INTO v_driver_skill_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'driver_skill_paths', 'null'::jsonb)) = 'array' THEN v_policy->'driver_skill_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_vehicle_skill_paths
         )
    INTO v_vehicle_skill_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'vehicle_skill_paths', 'null'::jsonb)) = 'array' THEN v_policy->'vehicle_skill_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_vehicle_capacity_paths
         )
    INTO v_vehicle_capacity_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'vehicle_capacity_paths', 'null'::jsonb)) = 'array' THEN v_policy->'vehicle_capacity_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_stop_driver_skill_paths
         )
    INTO v_stop_driver_skill_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'stop_driver_skill_paths', 'null'::jsonb)) = 'array' THEN v_policy->'stop_driver_skill_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_stop_vehicle_skill_paths
         )
    INTO v_stop_vehicle_skill_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'stop_vehicle_skill_paths', 'null'::jsonb)) = 'array' THEN v_policy->'stop_vehicle_skill_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  SELECT COALESCE(
           array_agg(NULLIF(btrim(value), '')) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           v_stop_capacity_paths
         )
    INTO v_stop_capacity_paths
    FROM jsonb_array_elements_text(
      CASE
        WHEN jsonb_typeof(COALESCE(v_policy->'stop_capacity_paths', 'null'::jsonb)) = 'array' THEN v_policy->'stop_capacity_paths'
        ELSE '[]'::jsonb
      END
    ) AS item(value);

  v_stops := public.route_plan_resolve_stops_v1(v_plan.id);
  IF jsonb_typeof(v_stops) IS DISTINCT FROM 'array' THEN
    v_stops := '[]'::jsonb;
  END IF;
  v_stop_count := jsonb_array_length(v_stops);

  BEGIN
    v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_driver_user_id := NULL;
  END;

  BEGIN
    v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_vehicle_id := NULL;
  END;

  v_required_driver_skill_keys := public.route_plan_text_array_v1(v_plan.constraints->'required_driver_skill_keys');
  v_required_vehicle_skill_keys := public.route_plan_text_array_v1(v_plan.constraints->'required_vehicle_skill_keys');
  v_capacity_demand := public.route_plan_normalize_numeric_map_v1(v_plan.constraints->'capacity_demand');

  FOR v_stop IN
    SELECT value
    FROM jsonb_array_elements(v_stops) AS value
  LOOP
    v_required_driver_skill_keys := (
      SELECT COALESCE(array_agg(DISTINCT item ORDER BY item), ARRAY[]::text[])
      FROM (
        SELECT unnest(v_required_driver_skill_keys) AS item
        UNION ALL
        SELECT unnest(public.route_plan_collect_text_set_v1(v_stop, v_stop_driver_skill_paths)) AS item
      ) AS merged
      WHERE item IS NOT NULL
    );

    v_required_vehicle_skill_keys := (
      SELECT COALESCE(array_agg(DISTINCT item ORDER BY item), ARRAY[]::text[])
      FROM (
        SELECT unnest(v_required_vehicle_skill_keys) AS item
        UNION ALL
        SELECT unnest(public.route_plan_collect_text_set_v1(v_stop, v_stop_vehicle_skill_paths)) AS item
      ) AS merged
      WHERE item IS NOT NULL
    );

    v_capacity_value := public.route_plan_first_path_value_v1(v_stop, v_stop_capacity_paths);
    IF jsonb_typeof(COALESCE(v_capacity_value, 'null'::jsonb)) = 'object' THEN
      v_capacity_demand := public.route_plan_sum_numeric_maps_v1(
        v_capacity_demand,
        public.route_plan_normalize_numeric_map_v1(v_capacity_value)
      );
    END IF;
  END LOOP;

  IF v_enforce_stop_count_capacity AND v_stop_count_capacity_key IS NOT NULL THEN
    v_capacity_demand := public.route_plan_sum_numeric_maps_v1(
      v_capacity_demand,
      jsonb_build_object(v_stop_count_capacity_key, v_stop_count)
    );
  END IF;

  v_needs_driver_validation := array_length(v_required_driver_skill_keys, 1) IS NOT NULL;
  v_needs_vehicle_validation := (
    array_length(v_required_vehicle_skill_keys, 1) IS NOT NULL
    OR (jsonb_typeof(v_capacity_demand) = 'object' AND v_capacity_demand <> '{}'::jsonb)
  );

  IF v_needs_driver_validation AND v_driver_user_id IS NOT NULL THEN
    SELECT u.*
      INTO v_driver
      FROM public.users u
     WHERE u.id = v_driver_user_id
     LIMIT 1;

    SELECT dp.*
      INTO v_driver_profile
      FROM public.driver_profiles dp
     WHERE dp.organization_id = v_plan.organization_id
       AND dp.user_id = v_driver_user_id
     LIMIT 1;

    v_driver_profile_doc := jsonb_build_object(
      'metadata',
      COALESCE(v_driver_profile.metadata, '{}'::jsonb)
    );
    v_driver_skill_keys := public.route_plan_collect_text_set_v1(v_driver_profile_doc, v_driver_skill_paths);
  ELSE
    v_driver_skill_keys := ARRAY[]::text[];
  END IF;

  IF v_needs_vehicle_validation AND v_vehicle_id IS NOT NULL THEN
    SELECT v.*
      INTO v_vehicle
      FROM public.vehicles v
     WHERE v.id = v_vehicle_id
     LIMIT 1;

    IF v_vehicle.vehicle_type_id IS NOT NULL THEN
      SELECT vt.*
        INTO v_vehicle_type
        FROM public.vehicle_types vt
       WHERE vt.id = v_vehicle.vehicle_type_id
       LIMIT 1;
    END IF;

    v_vehicle_profile_doc := jsonb_build_object(
      'metadata',
      public.deep_merge_jsonb(
        COALESCE(v_vehicle_type.metadata, '{}'::jsonb),
        COALESCE(v_vehicle.metadata, '{}'::jsonb)
      )
    );
    v_vehicle_skill_keys := public.route_plan_collect_text_set_v1(v_vehicle_profile_doc, v_vehicle_skill_paths);
    v_vehicle_capacity := public.route_plan_normalize_numeric_map_v1(
      public.route_plan_first_path_value_v1(v_vehicle_profile_doc, v_vehicle_capacity_paths)
    );
  ELSE
    v_vehicle_skill_keys := ARRAY[]::text[];
    v_vehicle_capacity := '{}'::jsonb;
  END IF;

  IF v_enabled IS NOT TRUE THEN
    RETURN jsonb_strip_nulls(jsonb_build_object(
      'valid', TRUE,
      'enabled', FALSE,
      'route_plan_id', v_plan.id,
      'organization_id', v_plan.organization_id,
      'branch_id', v_plan.branch_id,
      'planned_date', v_plan.planned_date,
      'stop_count', v_stop_count,
      'driver_user_id', v_driver_user_id,
      'vehicle_id', v_vehicle_id,
      'settings_id', v_policy_row.settings_id,
      'settings_version_id', v_policy_row.settings_version_id,
      'policy_version', COALESCE(v_policy_row.version, 1),
      'required_driver_skill_keys', to_jsonb(v_required_driver_skill_keys),
      'required_vehicle_skill_keys', to_jsonb(v_required_vehicle_skill_keys),
      'capacity_demand', v_capacity_demand,
      'violations', '[]'::jsonb
    ));
  END IF;

  IF v_needs_driver_validation AND v_driver_user_id IS NOT NULL THEN
    IF v_driver.id IS NULL THEN
      v_violations := v_violations || jsonb_build_array(jsonb_build_object(
        'code', 'driver_not_found',
        'message', format('Assigned driver %s was not found.', v_driver_user_id)
      ));
    ELSE
      IF COALESCE(NULLIF(btrim(COALESCE(v_driver.status, '')), ''), '') <> ''
         AND NOT (lower(v_driver.status) = ANY (v_driver_statuses)) THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'driver_inactive',
          'message', format('Assigned driver %s is not in an allowed status (%s).', v_driver_user_id, array_to_string(v_driver_statuses, ', '))
        ));
      END IF;

      IF v_assigned_driver_user_type IS NOT NULL
         AND lower(COALESCE(NULLIF(btrim(v_driver.user_type), ''), '')) <> v_assigned_driver_user_type THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'driver_user_type_invalid',
          'message', format('Assigned user %s must have user_type %s for route planning.', v_driver_user_id, v_assigned_driver_user_type)
        ));
      END IF;

      IF v_driver_profile.id IS NOT NULL
         AND lower(COALESCE(NULLIF(btrim(v_driver_profile.status), ''), '')) <> 'active' THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'driver_profile_inactive',
          'message', format('Assigned driver profile %s is not active.', v_driver_profile.id)
        ));
      END IF;
    END IF;
  END IF;

  IF array_length(v_required_driver_skill_keys, 1) IS NOT NULL THEN
    IF v_driver_user_id IS NULL THEN
      v_violations := v_violations || jsonb_build_array(jsonb_build_object(
        'code', 'driver_required_for_skills',
        'message', 'Driver skill constraints were declared but no driver_user_id is assigned.'
      ));
    ELSE
      SELECT COALESCE(array_agg(skill ORDER BY skill), ARRAY[]::text[])
        INTO v_missing_driver_skill_keys
        FROM (
          SELECT required_skill AS skill
          FROM unnest(v_required_driver_skill_keys) AS required_skill
          EXCEPT
          SELECT available_skill
          FROM unnest(v_driver_skill_keys) AS available_skill
        ) AS missing;

      IF array_length(v_missing_driver_skill_keys, 1) IS NOT NULL THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'driver_skill_missing',
          'message', format('Assigned driver %s is missing required skill keys: %s.', v_driver_user_id, array_to_string(v_missing_driver_skill_keys, ', ')),
          'missing_skill_keys', to_jsonb(v_missing_driver_skill_keys)
        ));
      END IF;
    END IF;
  END IF;

  IF v_needs_vehicle_validation AND v_vehicle_id IS NOT NULL THEN
    IF v_vehicle.id IS NULL THEN
      v_violations := v_violations || jsonb_build_array(jsonb_build_object(
        'code', 'vehicle_not_found',
        'message', format('Assigned vehicle %s was not found.', v_vehicle_id)
      ));
    ELSE
      IF COALESCE(v_vehicle.is_active, TRUE) IS NOT TRUE THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'vehicle_inactive',
          'message', format('Assigned vehicle %s is not active.', v_vehicle_id)
        ));
      END IF;

      IF COALESCE(NULLIF(btrim(COALESCE(v_vehicle.status, '')), ''), '') <> ''
         AND NOT (lower(v_vehicle.status) = ANY (v_vehicle_statuses)) THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'vehicle_status_invalid',
          'message', format('Assigned vehicle %s is not in an allowed status (%s).', v_vehicle_id, array_to_string(v_vehicle_statuses, ', '))
        ));
      END IF;
    END IF;
  END IF;

  IF array_length(v_required_vehicle_skill_keys, 1) IS NOT NULL THEN
    IF v_vehicle_id IS NULL THEN
      v_violations := v_violations || jsonb_build_array(jsonb_build_object(
        'code', 'vehicle_required_for_skills',
        'message', 'Vehicle skill constraints were declared but no vehicle_id is assigned.'
      ));
    ELSE
      SELECT COALESCE(array_agg(skill ORDER BY skill), ARRAY[]::text[])
        INTO v_missing_vehicle_skill_keys
        FROM (
          SELECT required_skill AS skill
          FROM unnest(v_required_vehicle_skill_keys) AS required_skill
          EXCEPT
          SELECT available_skill
          FROM unnest(v_vehicle_skill_keys) AS available_skill
        ) AS missing;

      IF array_length(v_missing_vehicle_skill_keys, 1) IS NOT NULL THEN
        v_violations := v_violations || jsonb_build_array(jsonb_build_object(
          'code', 'vehicle_skill_missing',
          'message', format('Assigned vehicle %s is missing required skill keys: %s.', v_vehicle_id, array_to_string(v_missing_vehicle_skill_keys, ', ')),
          'missing_skill_keys', to_jsonb(v_missing_vehicle_skill_keys)
        ));
      END IF;
    END IF;
  END IF;

  IF jsonb_typeof(v_capacity_demand) = 'object' AND v_capacity_demand <> '{}'::jsonb THEN
    IF v_vehicle_id IS NULL THEN
      v_violations := v_violations || jsonb_build_array(jsonb_build_object(
        'code', 'vehicle_required_for_capacity',
        'message', 'Capacity demand was declared but no vehicle_id is assigned.'
      ));
    ELSE
      FOR v_capacity_entry IN
        SELECT key, value
        FROM jsonb_each(v_capacity_demand)
      LOOP
        BEGIN
          v_capacity_required := NULLIF(v_capacity_entry.value::text, '')::NUMERIC;
        EXCEPTION
          WHEN others THEN
            v_capacity_required := NULL;
        END;

        BEGIN
          v_capacity_limit := NULLIF(v_vehicle_capacity->>v_capacity_entry.key, '')::NUMERIC;
        EXCEPTION
          WHEN others THEN
            v_capacity_limit := NULL;
        END;

        IF COALESCE(v_capacity_required, 0) <= 0 THEN
          CONTINUE;
        END IF;

        IF v_capacity_limit IS NULL THEN
          v_violations := v_violations || jsonb_build_array(jsonb_build_object(
            'code', 'vehicle_capacity_missing',
            'message', format('Assigned vehicle %s does not declare capacity key %s required by the route plan.', v_vehicle_id, v_capacity_entry.key),
            'capacity_key', v_capacity_entry.key
          ));
        ELSIF v_capacity_required > v_capacity_limit THEN
          v_violations := v_violations || jsonb_build_array(jsonb_build_object(
            'code', 'vehicle_capacity_exceeded',
            'message', format('Assigned vehicle %s capacity %s (%s) is below required demand %s.', v_vehicle_id, v_capacity_entry.key, v_capacity_limit, v_capacity_required),
            'capacity_key', v_capacity_entry.key,
            'required', v_capacity_required,
            'available', v_capacity_limit
          ));
        END IF;
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'valid', jsonb_array_length(v_violations) = 0,
    'enabled', TRUE,
    'route_plan_id', v_plan.id,
    'organization_id', v_plan.organization_id,
    'branch_id', v_plan.branch_id,
    'planned_date', v_plan.planned_date,
    'stop_count', v_stop_count,
    'driver_user_id', v_driver_user_id,
    'vehicle_id', v_vehicle_id,
    'required_driver_skill_keys', to_jsonb(v_required_driver_skill_keys),
    'required_vehicle_skill_keys', to_jsonb(v_required_vehicle_skill_keys),
    'driver_skill_keys', to_jsonb(v_driver_skill_keys),
    'vehicle_skill_keys', to_jsonb(v_vehicle_skill_keys),
    'capacity_demand', v_capacity_demand,
    'vehicle_capacity', v_vehicle_capacity,
    'settings_id', v_policy_row.settings_id,
    'settings_version_id', v_policy_row.settings_version_id,
    'policy_version', COALESCE(v_policy_row.version, 1),
    'validated_at', now(),
    'violations', v_violations
  ));
END;
$function$;

COMMENT ON FUNCTION public.route_plan_validate_constraints_v1(UUID)
  IS 'Validate declared route_plans.constraints against canonical driver, vehicle, and stop metadata before freeze/apply.';

REVOKE ALL ON FUNCTION public.route_plan_validate_constraints_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_plan_validate_constraints_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_plan_validate_constraints_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_plan_validate_constraints_v1(UUID) TO service_role;

-------------------------------------------------------------------------------
-- 4) Freeze/apply guards
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.freeze_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  status TEXT,
  stop_count INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;
  v_stops JSONB := '[]'::jsonb;
  v_stop_count INT := 0;
  v_from_status TEXT := NULL;
  v_constraint_report JSONB := '{}'::jsonb;
  v_constraint_messages TEXT := NULL;
  v_constraint_valid BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.status
    INTO v_from_status
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_from_status IS NULL THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  IF v_from_status NOT IN ('created', 'submitted', 'solved', 'frozen') THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires route_plan in created/submitted/solved/frozen state (got %)', v_from_status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires stops array on route_plan %', v_route_plan_id USING ERRCODE = '23514';
  END IF;

  v_stop_count := jsonb_array_length(v_stops);
  IF v_stop_count < 1 THEN
    RAISE EXCEPTION 'freeze_route_plan_v1 requires at least one stop on route_plan %', v_route_plan_id USING ERRCODE = '23514';
  END IF;

  v_constraint_report := public.route_plan_validate_constraints_v1(v_route_plan_id);

  BEGIN
    v_constraint_valid := COALESCE((v_constraint_report->>'valid')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_constraint_valid := FALSE;
  END;

  IF v_constraint_valid IS NOT TRUE THEN
    SELECT string_agg(item.value->>'message', '; ' ORDER BY item.ord)
      INTO v_constraint_messages
      FROM jsonb_array_elements(COALESCE(v_constraint_report->'violations', '[]'::jsonb)) WITH ORDINALITY AS item(value, ord);

    RAISE EXCEPTION 'freeze_route_plan_v1 constraint validation failed for route_plan %: %',
      v_route_plan_id,
      COALESCE(v_constraint_messages, 'unknown violation')
      USING ERRCODE = '23514',
            DETAIL = left(COALESCE(v_constraint_report::text, '{}'), 4000);
  END IF;

  IF v_from_status <> 'frozen' THEN
    UPDATE public.route_plans
       SET status = 'frozen',
           solved_at = COALESCE(solved_at, now()),
           metadata = public.deep_merge_jsonb(
             COALESCE(metadata, '{}'::jsonb),
             jsonb_build_object('constraint_validation', v_constraint_report)
           ),
           updated_at = now()
     WHERE id = v_route_plan_id;

    PERFORM public.route_plan_log_event_v1(
      v_route_plan_id,
      'frozen',
      v_from_status,
      'frozen',
      jsonb_build_object(
        'stop_count', v_stop_count,
        'constraint_validation', v_constraint_report
      ),
      v_actor_user_id,
      v_actor_system,
      COALESCE(v_idempotency_key, format('route-plan:%s:freeze', v_route_plan_id))
    );
  END IF;

  route_plan_id := v_route_plan_id;
  status := 'frozen';
  stop_count := v_stop_count;
  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.apply_route_plan_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_plan_id UUID,
  route_run_id UUID,
  stop_ids UUID[],
  created BOOLEAN,
  status TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_route_plan_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_idempotency_key TEXT := NULL;

  v_plan RECORD;
  v_stops JSONB := '[]'::jsonb;
  v_create_result RECORD;
  v_existing_route_run_id UUID := NULL;
  v_driver_user_id UUID := NULL;
  v_vehicle_id UUID := NULL;
  v_from_status TEXT := NULL;
  v_constraint_report JSONB := '{}'::jsonb;
  v_constraint_messages TEXT := NULL;
  v_constraint_valid BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 expects JSON object input' USING ERRCODE = '23514';
  END IF;

  BEGIN v_route_plan_id := NULLIF(v_input->>'route_plan_id', '')::uuid; EXCEPTION WHEN others THEN v_route_plan_id := NULL; END;
  BEGIN v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid; EXCEPTION WHEN others THEN v_actor_user_id := NULL; END;
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_plan_service');
  v_idempotency_key := COALESCE(
    NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), ''),
    format('route-plan:%s:apply', v_route_plan_id)
  );

  IF v_route_plan_id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 missing route_plan_id' USING ERRCODE = '23514';
  END IF;

  SELECT rp.*
    INTO v_plan
    FROM public.route_plans rp
   WHERE rp.id = v_route_plan_id
   LIMIT 1;

  IF v_plan.id IS NULL THEN
    RAISE EXCEPTION 'apply_route_plan_v1 route_plan % not found', v_route_plan_id USING ERRCODE = '23503';
  END IF;

  v_from_status := v_plan.status;

  SELECT rr.id
    INTO v_existing_route_run_id
    FROM public.route_runs rr
   WHERE rr.route_plan_id = v_route_plan_id
   LIMIT 1;

  IF v_plan.status = 'applied' AND v_existing_route_run_id IS NOT NULL THEN
    route_plan_id := v_route_plan_id;
    route_run_id := v_existing_route_run_id;
    stop_ids := ARRAY(
      SELECT rs.id
      FROM public.route_stops rs
      WHERE rs.route_run_id = v_existing_route_run_id
      ORDER BY rs.sequence_order
    );
    created := FALSE;
    status := 'applied';
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_plan.status <> 'frozen' THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires route_plan % to be frozen (got %)', v_route_plan_id, v_plan.status
      USING ERRCODE = '23514';
  END IF;

  v_stops := public.route_plan_resolve_stops_v1(v_route_plan_id);
  IF jsonb_typeof(v_stops) <> 'array' OR jsonb_array_length(v_stops) < 1 THEN
    RAISE EXCEPTION 'apply_route_plan_v1 requires a frozen route_plan with at least one stop' USING ERRCODE = '23514';
  END IF;

  v_constraint_report := public.route_plan_validate_constraints_v1(v_route_plan_id);

  BEGIN
    v_constraint_valid := COALESCE((v_constraint_report->>'valid')::BOOLEAN, FALSE);
  EXCEPTION
    WHEN others THEN
      v_constraint_valid := FALSE;
  END;

  IF v_constraint_valid IS NOT TRUE THEN
    SELECT string_agg(item.value->>'message', '; ' ORDER BY item.ord)
      INTO v_constraint_messages
      FROM jsonb_array_elements(COALESCE(v_constraint_report->'violations', '[]'::jsonb)) WITH ORDINALITY AS item(value, ord);

    RAISE EXCEPTION 'apply_route_plan_v1 constraint validation failed for route_plan %: %',
      v_route_plan_id,
      COALESCE(v_constraint_messages, 'unknown violation')
      USING ERRCODE = '23514',
            DETAIL = left(COALESCE(v_constraint_report::text, '{}'), 4000);
  END IF;

  BEGIN v_driver_user_id := NULLIF(COALESCE(v_plan.solution->>'driver_user_id', v_plan.inputs->>'driver_user_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_driver_user_id := NULL; END;
  BEGIN v_vehicle_id := NULLIF(COALESCE(v_plan.solution->>'vehicle_id', v_plan.inputs->>'vehicle_id', ''), '')::uuid; EXCEPTION WHEN others THEN v_vehicle_id := NULL; END;

  SELECT *
    INTO v_create_result
    FROM public.create_route_run_v1(
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_plan.organization_id,
        'branch_id', v_plan.branch_id,
        'driver_user_id', v_driver_user_id,
        'vehicle_id', v_vehicle_id,
        'planned_date', v_plan.planned_date,
        'status', 'planned',
        'idempotency_key', v_idempotency_key,
        'stops', v_stops,
        'metadata',
          COALESCE(v_plan.metadata, '{}'::jsonb)
          || jsonb_build_object(
            'route_plan_id', v_plan.id,
            'route_plan_version', v_plan.version
          )
      ))
    )
    LIMIT 1;

  UPDATE public.route_runs
     SET route_plan_id = v_route_plan_id,
         updated_at = now()
   WHERE id = v_create_result.route_run_id
     AND (
       public.route_runs.route_plan_id IS NULL
       OR public.route_runs.route_plan_id = v_route_plan_id
     );

  IF NOT EXISTS (
    SELECT 1
    FROM public.route_runs rr
    WHERE rr.id = v_create_result.route_run_id
      AND rr.route_plan_id = v_route_plan_id
  ) THEN
    RAISE EXCEPTION 'apply_route_plan_v1 could not link route_run % to route_plan %', v_create_result.route_run_id, v_route_plan_id
      USING ERRCODE = '23514';
  END IF;

  UPDATE public.route_plans
     SET status = 'applied',
         applied_at = COALESCE(applied_at, now()),
         metadata = public.deep_merge_jsonb(
           COALESCE(metadata, '{}'::jsonb),
           jsonb_build_object('constraint_validation', v_constraint_report)
         ),
         updated_at = now()
   WHERE id = v_route_plan_id;

  PERFORM public.route_plan_log_event_v1(
    v_route_plan_id,
    'applied',
    v_from_status,
    'applied',
    jsonb_strip_nulls(jsonb_build_object(
      'route_run_id', v_create_result.route_run_id,
      'stop_ids', to_jsonb(v_create_result.stop_ids),
      'constraint_validation', v_constraint_report
    )),
    v_actor_user_id,
    v_actor_system,
    v_idempotency_key
  );

  route_plan_id := v_route_plan_id;
  route_run_id := v_create_result.route_run_id;
  stop_ids := v_create_result.stop_ids;
  created := COALESCE(v_create_result.created, FALSE);
  status := 'applied';
  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.freeze_route_plan_v1(JSONB) IS
  'Service write-path: validate declared route-plan constraints, then freeze a route_plan before execution rows are materialized.';
COMMENT ON FUNCTION public.apply_route_plan_v1(JSONB) IS
  'Service write-path: revalidate declared route-plan constraints, then apply a frozen route_plan into route_runs/route_stops via create_route_run_v1.';

SELECT pg_advisory_unlock(hashtext('202604061130_route_plan_constraint_guards_v1'));
COMMIT;
