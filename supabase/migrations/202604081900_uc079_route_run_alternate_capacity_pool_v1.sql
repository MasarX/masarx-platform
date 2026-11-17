-- Plan: PLAN-202604-b06-route-run-assignment / Step: E03
-- Migration: UC079 route run alternate capacity pool write path
-- Date: 2026-04-08
--
-- Goals:
--   - Extend the canonical route assignment path to resolve alternate capacity
--     from row-driven policy + marketplace private pools.
--   - Persist the decision through the canonical assignment projection,
--     decision log, and assignment event trail.
--   - Keep the browser-safe UI/API path on the same route assignment RPC.

BEGIN;

SELECT pg_advisory_lock(hashtext('202604081900_uc079_route_run_alternate_capacity_pool_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Route assignment policy substrate
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_assignment_policy_default_v1()
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $function$
  SELECT jsonb_build_object(
    'version', 1,
    'alternate_capacity', jsonb_build_object(
      'enabled', true,
      'source_type', 'marketplace_private_pool',
      'selection_mode', 'first_private_pool_member',
      'allowed_demand_classes', jsonb_build_array('express', 'overflow'),
      'allowed_request_kind_keys', jsonb_build_array('capacity_block'),
      'route_metadata_demand_class_paths', jsonb_build_array(
        '$.alternate_capacity.demand_class',
        '$.assignment_request.demand_class',
        '$.dispatch.assignment_request.demand_class'
      ),
      'shipment_metadata_demand_class_paths', jsonb_build_array(
        '$.alternate_capacity.demand_class',
        '$.assignment_request.demand_class',
        '$.dispatch.assignment_request.demand_class'
      ),
      'route_metadata_marketplace_request_id_paths', jsonb_build_array(
        '$.alternate_capacity.marketplace_request_id',
        '$.assignment_request.marketplace_request_id',
        '$.dispatch.assignment_request.marketplace_request_id'
      ),
      'shipment_metadata_marketplace_request_id_paths', jsonb_build_array(
        '$.alternate_capacity.marketplace_request_id',
        '$.assignment_request.marketplace_request_id',
        '$.dispatch.assignment_request.marketplace_request_id'
      )
    )
  );
$function$;

COMMENT ON FUNCTION public.route_assignment_policy_default_v1()
  IS 'Canonical default policy for route assignment alternate-capacity resolution.';

REVOKE ALL ON FUNCTION public.route_assignment_policy_default_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_assignment_policy_default_v1() FROM anon;
REVOKE ALL ON FUNCTION public.route_assignment_policy_default_v1() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_assignment_policy_default_v1() TO service_role;

INSERT INTO public.lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
  ld.id,
  'alternate_capacity_pool',
  'Alternate capacity pool',
  'Route run assigned through a row-driven alternate capacity source such as a marketplace private pool.',
  30,
  FALSE,
  '{}'::jsonb
FROM public.lookup_definitions ld
WHERE ld.category = 'route_assignment_mode'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    metadata = EXCLUDED.metadata;

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
  'route_assignment_policy',
  'Row-driven alternate-capacity source resolution for route assignments.',
  TRUE,
  TRUE,
  TRUE,
  'hard_fail',
  '["global","tenant","client","sender","resource"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET description = EXCLUDED.description,
    requires_schema = EXCLUDED.requires_schema,
    requires_global_default = EXCLUDED.requires_global_default,
    side_effecting = EXCLUDED.side_effecting,
    safe_missing_behavior = EXCLUDED.safe_missing_behavior,
    allowed_scopes = EXCLUDED.allowed_scopes,
    updated_at = now();

UPDATE public.settings_category_registry
   SET resource_scope_rel = 'public.branches'::regclass,
       updated_at = now()
 WHERE category = 'route_assignment_policy';

INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
SELECT
  'route_assignment_policy',
  1,
  '{
    "$schema": "http://json-schema.org/draft-07/schema#",
    "title": "Route Assignment Policy",
    "type": "object",
    "additionalProperties": true,
    "properties": {
      "version": { "type": "integer", "minimum": 1 },
      "alternate_capacity": {
        "type": ["object", "null"],
        "additionalProperties": true,
        "properties": {
          "enabled": { "type": ["boolean", "null"] },
          "source_type": { "type": ["string", "null"] },
          "selection_mode": { "type": ["string", "null"] },
          "allowed_demand_classes": { "type": ["array", "null"], "items": { "type": "string" } },
          "allowed_request_kind_keys": { "type": ["array", "null"], "items": { "type": "string" } },
          "route_metadata_demand_class_paths": { "type": ["array", "null"], "items": { "type": "string" } },
          "shipment_metadata_demand_class_paths": { "type": ["array", "null"], "items": { "type": "string" } },
          "route_metadata_marketplace_request_id_paths": { "type": ["array", "null"], "items": { "type": "string" } },
          "shipment_metadata_marketplace_request_id_paths": { "type": ["array", "null"], "items": { "type": "string" } }
        }
      }
    }
  }'::jsonb,
  'Route assignment policy for alternate capacity sources resolved from the settings ladder.',
  jsonb_build_array(public.route_assignment_policy_default_v1()),
  TRUE
WHERE NOT EXISTS (
  SELECT 1
    FROM public.schema_registry sr
   WHERE sr.category = 'route_assignment_policy'
     AND sr.version = 1
);

WITH default_policy AS (
  SELECT public.route_assignment_policy_default_v1() AS value
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
  'route_assignment_policy',
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
   WHERE sv.category = 'route_assignment_policy'
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
WHERE sv.category = 'route_assignment_policy'
  AND sv.scope_type = 'global'
  AND sv.scope_id IS NULL
  AND NOT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = sv.category
       AND s.scope_type = sv.scope_type
       AND s.scope_id IS NULL
  );

CREATE OR REPLACE FUNCTION public.route_assignment_policy_resolve_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settings_resolution_id UUID,
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
  v_context JSONB := COALESCE(p_context, '{}'::jsonb);
  v_policy_row RECORD;
  v_org_id UUID := NULL;
BEGIN
  BEGIN
    v_org_id := NULLIF(v_context->>'organization_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row_from_policy_context_v1(
      'route_assignment_policy',
      v_context
    )
   LIMIT 1;

  value := public.jsonb_deep_merge(
    public.route_assignment_policy_default_v1(),
    COALESCE(v_policy_row.value, '{}'::jsonb)
  );
  settings_id := v_policy_row.settings_id;
  settings_version_id := v_policy_row.settings_version_id;
  scope_type := COALESCE(v_policy_row.scope_type, 'global');
  scope_id := v_policy_row.scope_id;
  version := COALESCE(v_policy_row.version, 1);
  scope_path := COALESCE(
    v_policy_row.scope_path,
    jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL))
  );

  settings_resolution_id := public.log_settings_resolution(
    p_organization_id := v_org_id,
    p_category := 'route_assignment_policy',
    p_winning_scope_type := scope_type,
    p_winning_scope_id := scope_id,
    p_winning_settings_id := settings_id,
    p_winning_settings_version_id := settings_version_id,
    p_winning_version := version,
    p_scope_path := scope_path,
    p_inputs := v_context,
    p_merge_notes := jsonb_build_object('resolver', 'route_assignment_policy_resolve_v1')
  );

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.route_assignment_policy_resolve_v1(JSONB)
  IS 'Resolve and log the winning route_assignment_policy row for alternate-capacity assignment decisions.';

REVOKE ALL ON FUNCTION public.route_assignment_policy_resolve_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_assignment_policy_resolve_v1(JSONB) FROM anon;
REVOKE ALL ON FUNCTION public.route_assignment_policy_resolve_v1(JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_assignment_policy_resolve_v1(JSONB) TO service_role;

-------------------------------------------------------------------------------
-- 2) Alternate-capacity resolution helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.route_assignment_jsonpath_first_text_v1(
  p_document JSONB,
  p_paths JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_path TEXT;
  v_value JSONB;
  v_text TEXT;
BEGIN
  IF p_document IS NULL OR jsonb_typeof(COALESCE(p_paths, 'null'::jsonb)) <> 'array' THEN
    RETURN NULL;
  END IF;

  FOR v_path IN
    SELECT NULLIF(btrim(value), '')
      FROM jsonb_array_elements_text(p_paths) AS item(value)
  LOOP
    IF v_path IS NULL THEN
      CONTINUE;
    END IF;

    v_value := public.safe_jsonpath_query_first(p_document, v_path);
    IF v_value IS NULL OR jsonb_typeof(v_value) = 'null' THEN
      CONTINUE;
    END IF;

    v_text := NULLIF(trim(both '"' FROM v_value::text), '');
    IF v_text IS NOT NULL THEN
      RETURN v_text;
    END IF;
  END LOOP;

  RETURN NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.route_assignment_jsonpath_first_uuid_v1(
  p_document JSONB,
  p_paths JSONB
)
RETURNS UUID
LANGUAGE plpgsql
IMMUTABLE
AS $function$
DECLARE
  v_text TEXT;
BEGIN
  v_text := public.route_assignment_jsonpath_first_text_v1(p_document, p_paths);
  IF v_text IS NULL THEN
    RETURN NULL;
  END IF;

  BEGIN
    RETURN v_text::uuid;
  EXCEPTION
    WHEN others THEN
      RETURN NULL;
  END;
END;
$function$;

CREATE OR REPLACE FUNCTION public.route_run_resolve_alternate_capacity_v1(
  p_route_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_route_run public.route_runs%ROWTYPE;
  v_first_stop RECORD;
  v_policy_ctx JSONB := '{}'::jsonb;
  v_policy_row RECORD;
  v_alt_policy JSONB := '{}'::jsonb;
  v_demand_class TEXT := NULL;
  v_marketplace_request_id UUID := NULL;
  v_allowed_demand_classes TEXT[] := ARRAY[]::TEXT[];
  v_allowed_request_kind_keys TEXT[] := ARRAY[]::TEXT[];
  v_request public.marketplace_requests%ROWTYPE;
  v_supplier_org_id UUID := NULL;
  v_supplier_name TEXT := NULL;
  v_partner JSONB := '{}'::jsonb;
  v_metadata JSONB := '{}'::jsonb;
BEGIN
  IF p_route_run_id IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = p_route_run_id
   LIMIT 1;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', p_route_run_id
      USING ERRCODE = '23503';
  END IF;

  SELECT
    rs.id AS route_stop_id,
    rs.client_id,
    s.metadata AS shipment_metadata,
    c.sender_id
    INTO v_first_stop
    FROM public.route_stops rs
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
    LEFT JOIN public.clients c
      ON c.id = rs.client_id
   WHERE rs.route_run_id = p_route_run_id
   ORDER BY rs.sequence_order, rs.created_at, rs.id
   LIMIT 1;

  v_policy_ctx := jsonb_strip_nulls(
    jsonb_build_object(
      'resource_id', v_route_run.branch_id,
      'client_id', v_first_stop.client_id,
      'sender_id', v_first_stop.sender_id,
      'organization_id', v_route_run.organization_id
    )
  );

  SELECT *
    INTO v_policy_row
    FROM public.route_assignment_policy_resolve_v1(v_policy_ctx)
   LIMIT 1;

  v_alt_policy := COALESCE(v_policy_row.value->'alternate_capacity', '{}'::jsonb);
  IF jsonb_typeof(v_alt_policy) IS DISTINCT FROM 'object' THEN
    v_alt_policy := '{}'::jsonb;
  END IF;

  IF NOT COALESCE((v_alt_policy->>'enabled')::boolean, FALSE) THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 alternate capacity is disabled for route_run %', p_route_run_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(
           array_agg(lower(NULLIF(btrim(value), ''))) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           ARRAY[]::TEXT[]
         )
    INTO v_allowed_demand_classes
    FROM jsonb_array_elements_text(COALESCE(v_alt_policy->'allowed_demand_classes', '[]'::jsonb)) AS item(value);

  SELECT COALESCE(
           array_agg(lower(NULLIF(btrim(value), ''))) FILTER (WHERE NULLIF(btrim(value), '') IS NOT NULL),
           ARRAY[]::TEXT[]
         )
    INTO v_allowed_request_kind_keys
    FROM jsonb_array_elements_text(COALESCE(v_alt_policy->'allowed_request_kind_keys', '[]'::jsonb)) AS item(value);

  v_demand_class := lower(COALESCE(
    public.route_assignment_jsonpath_first_text_v1(
      COALESCE(v_route_run.metadata, '{}'::jsonb),
      v_alt_policy->'route_metadata_demand_class_paths'
    ),
    public.route_assignment_jsonpath_first_text_v1(
      COALESCE(v_first_stop.shipment_metadata, '{}'::jsonb),
      v_alt_policy->'shipment_metadata_demand_class_paths'
    )
  ));

  IF v_demand_class IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 route_run % is missing alternate-capacity demand_class metadata', p_route_run_id
      USING ERRCODE = '23514';
  END IF;

  IF cardinality(v_allowed_demand_classes) > 0
     AND NOT (v_demand_class = ANY (v_allowed_demand_classes)) THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 demand_class % is not allowed for route_run %', v_demand_class, p_route_run_id
      USING ERRCODE = '23514';
  END IF;

  v_marketplace_request_id := COALESCE(
    public.route_assignment_jsonpath_first_uuid_v1(
      COALESCE(v_route_run.metadata, '{}'::jsonb),
      v_alt_policy->'route_metadata_marketplace_request_id_paths'
    ),
    public.route_assignment_jsonpath_first_uuid_v1(
      COALESCE(v_first_stop.shipment_metadata, '{}'::jsonb),
      v_alt_policy->'shipment_metadata_marketplace_request_id_paths'
    )
  );

  IF v_marketplace_request_id IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 route_run % is missing alternate-capacity marketplace_request_id metadata', p_route_run_id
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_request
    FROM public.marketplace_requests mr
   WHERE mr.id = v_marketplace_request_id
   LIMIT 1;

  IF v_request.id IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 marketplace_request % not found for route_run %', v_marketplace_request_id, p_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF v_request.requester_organization_id IS DISTINCT FROM v_route_run.organization_id THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 marketplace_request % does not belong to route_run organization %', v_marketplace_request_id, v_route_run.organization_id
      USING ERRCODE = '42501';
  END IF;

  IF cardinality(v_allowed_request_kind_keys) > 0
     AND NOT (lower(v_request.request_kind_key) = ANY (v_allowed_request_kind_keys)) THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 marketplace_request % kind % is not allowed', v_marketplace_request_id, v_request.request_kind_key
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(COALESCE(v_request.private_pool, 'null'::jsonb)) IS DISTINCT FROM 'array'
     OR jsonb_array_length(COALESCE(v_request.private_pool, '[]'::jsonb)) < 1 THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 marketplace_request % has no private_pool suppliers', v_marketplace_request_id
      USING ERRCODE = '23514';
  END IF;

  SELECT
    pool.value::uuid,
    supplier.name
    INTO v_supplier_org_id,
         v_supplier_name
    FROM jsonb_array_elements_text(v_request.private_pool) WITH ORDINALITY AS pool(value, ordinality)
    LEFT JOIN public.organizations supplier
      ON supplier.id = pool.value::uuid
   ORDER BY pool.ordinality
   LIMIT 1;

  IF v_supplier_org_id IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 marketplace_request % private_pool could not resolve a supplier organization', v_marketplace_request_id
      USING ERRCODE = '23514';
  END IF;

  v_partner := jsonb_strip_nulls(
    jsonb_build_object(
      'partner_id', v_supplier_org_id::text,
      'partner_name', COALESCE(v_supplier_name, v_supplier_org_id::text),
      'source_type', COALESCE(NULLIF(v_alt_policy->>'source_type', ''), 'marketplace_private_pool'),
      'selection_mode', COALESCE(NULLIF(v_alt_policy->>'selection_mode', ''), 'first_private_pool_member'),
      'demand_class', v_demand_class,
      'marketplace_request_id', v_request.id,
      'request_kind_key', v_request.request_kind_key,
      'release_state', v_request.release_state,
      'supplier_organization_id', v_supplier_org_id,
      'supplier_organization_name', v_supplier_name
    )
  );

  v_metadata := jsonb_strip_nulls(
    jsonb_build_object(
      'enabled', TRUE,
      'source_type', COALESCE(NULLIF(v_alt_policy->>'source_type', ''), 'marketplace_private_pool'),
      'selection_mode', COALESCE(NULLIF(v_alt_policy->>'selection_mode', ''), 'first_private_pool_member'),
      'demand_class', v_demand_class,
      'marketplace_request_id', v_request.id,
      'request_kind_key', v_request.request_kind_key,
      'release_state', v_request.release_state,
      'supplier_organization_id', v_supplier_org_id,
      'supplier_organization_name', v_supplier_name,
      'settings_id', v_policy_row.settings_id,
      'settings_version_id', v_policy_row.settings_version_id,
      'policy_scope_type', v_policy_row.scope_type,
      'policy_scope_id', v_policy_row.scope_id,
      'policy_version', v_policy_row.version,
      'scope_path', v_policy_row.scope_path
    )
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'assignment_mode', 'alternate_capacity_pool',
      'settings_resolution_id', v_policy_row.settings_resolution_id,
      'settings_id', v_policy_row.settings_id,
      'settings_version_id', v_policy_row.settings_version_id,
      'policy_scope_type', v_policy_row.scope_type,
      'policy_scope_id', v_policy_row.scope_id,
      'policy_version', v_policy_row.version,
      'scope_path', v_policy_row.scope_path,
      'partner', v_partner,
      'metadata', v_metadata
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID)
  IS 'Resolve alternate-capacity assignment details for a route_run from route_assignment_policy + marketplace private pools.';

REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) TO service_role;

-------------------------------------------------------------------------------
-- 3) Canonical assignment write path: alternate capacity pool
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.assign_route_run_v1(
  p_input JSONB
)
RETURNS TABLE (
  route_run_id UUID,
  route_run_assignment_id UUID,
  assignment_status TEXT,
  assignment_mode TEXT,
  assignment_version INT,
  driver_user_id UUID,
  vehicle_id UUID,
  partner JSONB,
  stop_task_count INT,
  assigned_task_count INT,
  created BOOLEAN
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_scope_type TEXT := NULL;
  v_scope_id UUID := NULL;
  v_actor_user_id UUID := NULL;
  v_actor_system TEXT := NULL;
  v_current_org_id UUID := NULL;
  v_is_service BOOLEAN := FALSE;
  v_is_platform BOOLEAN := FALSE;
  v_route_run_id UUID := NULL;
  v_route_run public.route_runs%ROWTYPE;
  v_current_assignment public.route_run_assignments%ROWTYPE;
  v_assignment_row public.route_run_assignments%ROWTYPE;
  v_requested_driver_user_id UUID := NULL;
  v_requested_vehicle_id UUID := NULL;
  v_requested_partner JSONB := NULL;
  v_requested_notes TEXT := NULL;
  v_requested_metadata JSONB := '{}'::jsonb;
  v_requested_status TEXT := 'assigned';
  v_requested_mode TEXT := NULL;
  v_input_assignment_mode TEXT := NULL;
  v_use_alternate_capacity BOOLEAN := FALSE;
  v_alternate_capacity JSONB := NULL;
  v_settings_resolution_id UUID := NULL;
  v_idempotency_key TEXT := NULL;
  v_existing_event public.route_run_assignment_events%ROWTYPE;
  v_same_state BOOLEAN := FALSE;
  v_next_version INT := 1;
  v_task RECORD;
  v_stop RECORD;
  v_task_create RECORD;
  v_task_assign RECORD;
  v_decision_id UUID := NULL;
  v_assignment_payload JSONB := '{}'::jsonb;
  v_stop_task_total INT := 0;
  v_assigned_task_total INT := 0;
  v_prev_actor_system TEXT := COALESCE(current_setting('app.actor_system', true), '');
  v_prev_claims TEXT := COALESCE(current_setting('request.jwt.claims', true), '');
  v_prev_role TEXT := COALESCE(current_setting('request.jwt.claim.role', true), '');
  v_prev_sub TEXT := COALESCE(current_setting('request.jwt.claim.sub', true), '');
  v_service_claims JSONB := '{}'::jsonb;
BEGIN
  IF jsonb_typeof(v_input) <> 'object' THEN
    RAISE EXCEPTION 'assign_route_run_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;

  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');
  v_is_service := session_user IN ('postgres', 'supabase_admin') OR v_role = 'service_role';
  v_is_platform := public.is_platform_user();
  v_scope_type := public.current_user_scope_type();
  v_scope_id := public.current_user_scope_id();
  v_current_org_id := public.current_user_org_id();

  BEGIN
    v_route_run_id := NULLIF(v_input->>'route_run_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_route_run_id := NULL;
  END;

  BEGIN
    v_requested_driver_user_id := NULLIF(v_input->>'driver_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_driver_user_id := NULL;
  END;

  BEGIN
    v_requested_vehicle_id := NULLIF(v_input->>'vehicle_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_requested_vehicle_id := NULL;
  END;

  BEGIN
    v_actor_user_id := NULLIF(v_input->>'actor_user_id', '')::uuid;
  EXCEPTION
    WHEN others THEN
      v_actor_user_id := NULL;
  END;

  v_requested_partner := COALESCE(v_input->'partner', '{}'::jsonb);
  IF jsonb_typeof(v_requested_partner) IS DISTINCT FROM 'object' THEN
    v_requested_partner := '{}'::jsonb;
  END IF;
  v_requested_partner := jsonb_strip_nulls(
    v_requested_partner
    || jsonb_build_object(
      'partner_id', NULLIF(v_input->>'partner_id', ''),
      'partner_name', NULLIF(v_input->>'partner_name', '')
    )
  );
  IF v_requested_partner = '{}'::jsonb THEN
    v_requested_partner := NULL;
  END IF;

  v_requested_notes := NULLIF(btrim(COALESCE(v_input->>'notes', '')), '');
  v_requested_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_requested_metadata) IS DISTINCT FROM 'object' THEN
    v_requested_metadata := '{}'::jsonb;
  END IF;
  v_idempotency_key := NULLIF(btrim(COALESCE(v_input->>'idempotency_key', '')), '');
  v_actor_system := COALESCE(NULLIF(btrim(COALESCE(v_input->>'actor_system', '')), ''), 'route_assignment');
  v_input_assignment_mode := lower(NULLIF(btrim(COALESCE(v_input->>'assignment_mode', '')), ''));
  v_use_alternate_capacity := COALESCE(
    CASE
      WHEN jsonb_typeof(v_input->'use_alternate_capacity') = 'boolean' THEN (v_input->>'use_alternate_capacity')::boolean
      ELSE NULL
    END,
    v_input_assignment_mode = 'alternate_capacity_pool',
    FALSE
  );

  IF v_route_run_id IS NULL THEN
    RAISE EXCEPTION 'assign_route_run_v1 requires route_run_id'
      USING ERRCODE = '23514';
  END IF;

  IF v_input_assignment_mode IS NOT NULL
     AND v_input_assignment_mode NOT IN ('internal_driver', 'partner_fleet', 'alternate_capacity_pool') THEN
    RAISE EXCEPTION 'assign_route_run_v1 invalid assignment_mode %', v_input_assignment_mode
      USING ERRCODE = '23514';
  END IF;

  IF v_use_alternate_capacity THEN
    IF v_requested_driver_user_id IS NOT NULL OR v_requested_vehicle_id IS NOT NULL OR v_requested_partner IS NOT NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 alternate capacity assignment cannot accept direct driver, vehicle, or partner payload'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    IF v_requested_driver_user_id IS NOT NULL AND v_requested_partner IS NOT NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 accepts either internal driver or partner payload, not both'
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_driver_user_id IS NULL AND v_requested_partner IS NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 requires driver_user_id or partner payload'
        USING ERRCODE = '23514';
    END IF;

    IF v_requested_partner IS NOT NULL AND v_requested_vehicle_id IS NOT NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 partner assignment cannot set vehicle_id directly'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NOT v_is_service THEN
    IF auth.uid() IS NULL THEN
      RAISE EXCEPTION 'assign_route_run_v1 requires authenticated user'
        USING ERRCODE = '42501';
    END IF;

    IF NOT public.user_has_resource_capability_v1('routes', 'write', v_scope_type, v_scope_id) THEN
      RAISE EXCEPTION 'assign_route_run_v1 requires routes.write capability'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform THEN
      IF v_scope_type IS DISTINCT FROM 'tenant' THEN
        RAISE EXCEPTION 'assign_route_run_v1 requires tenant scope'
          USING ERRCODE = '42501';
      END IF;
      IF v_current_org_id IS NULL THEN
        RAISE EXCEPTION 'assign_route_run_v1 requires organization context'
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_actor_user_id := COALESCE(v_actor_user_id, auth.uid());
  ELSIF v_actor_user_id IS NULL THEN
    BEGIN
      v_actor_user_id := NULLIF(v_claims->>'sub', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_actor_user_id := NULL;
    END;
  END IF;

  SELECT *
    INTO v_route_run
    FROM public.route_runs rr
   WHERE rr.id = v_route_run_id
   FOR UPDATE;

  IF v_route_run.id IS NULL THEN
    RAISE EXCEPTION 'route_run % not found', v_route_run_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT v_is_service AND NOT v_is_platform AND v_route_run.organization_id IS DISTINCT FROM v_current_org_id THEN
    RAISE EXCEPTION 'route_run % is outside the current organization', v_route_run_id
      USING ERRCODE = '42501';
  END IF;

  IF v_route_run.status IN ('completed', 'canceled') THEN
    RAISE EXCEPTION 'assign_route_run_v1 cannot mutate terminal route_run status %', v_route_run.status
      USING ERRCODE = '23514';
  END IF;

  IF v_use_alternate_capacity THEN
    v_alternate_capacity := public.route_run_resolve_alternate_capacity_v1(v_route_run_id);
    v_requested_mode := 'alternate_capacity_pool';
    v_requested_driver_user_id := NULL;
    v_requested_vehicle_id := NULL;
    v_requested_partner := COALESCE(v_alternate_capacity->'partner', '{}'::jsonb);
    v_requested_metadata := jsonb_strip_nulls(
      v_requested_metadata
      || jsonb_build_object(
        'alternate_capacity', COALESCE(v_alternate_capacity->'metadata', '{}'::jsonb)
      )
    );
    BEGIN
      v_settings_resolution_id := NULLIF(v_alternate_capacity->>'settings_resolution_id', '')::uuid;
    EXCEPTION
      WHEN others THEN
        v_settings_resolution_id := NULL;
    END;
  ELSIF v_requested_partner IS NOT NULL THEN
    v_requested_mode := 'partner_fleet';
    v_requested_driver_user_id := NULL;
    v_requested_vehicle_id := NULL;
  ELSE
    v_requested_mode := 'internal_driver';
  END IF;

  IF v_requested_mode = 'internal_driver' THEN
    PERFORM 1
      FROM public.users u
     WHERE u.id = v_requested_driver_user_id
       AND u.organization_id = v_route_run.organization_id
       AND COALESCE(u.status, 'active') = 'active';
    IF NOT FOUND THEN
      RAISE EXCEPTION 'assign_route_run_v1 driver_user_id % is not active inside organization %', v_requested_driver_user_id, v_route_run.organization_id
        USING ERRCODE = '42501';
    END IF;

    IF v_requested_vehicle_id IS NOT NULL THEN
      PERFORM 1
        FROM public.vehicles v
       WHERE v.id = v_requested_vehicle_id
         AND v.organization_id = v_route_run.organization_id
         AND COALESCE(v.status, 'active') = 'active';
      IF NOT FOUND THEN
        RAISE EXCEPTION 'assign_route_run_v1 vehicle_id % is not active inside organization %', v_requested_vehicle_id, v_route_run.organization_id
          USING ERRCODE = '42501';
      END IF;
    END IF;
  END IF;

  SELECT *
    INTO v_current_assignment
    FROM public.route_run_assignments rra
   WHERE rra.route_run_id = v_route_run_id
   FOR UPDATE;

  IF v_idempotency_key IS NOT NULL THEN
    SELECT *
      INTO v_existing_event
      FROM public.route_run_assignment_events ev
     WHERE ev.route_run_id = v_route_run_id
       AND ev.idempotency_key = v_idempotency_key
     LIMIT 1;

    IF v_existing_event.id IS NOT NULL THEN
      SELECT *
        INTO v_assignment_row
        FROM public.route_run_assignments rra
       WHERE rra.route_run_id = v_route_run_id;

      IF v_assignment_row.id IS NULL THEN
        RAISE EXCEPTION 'assign_route_run_v1 idempotency replay missing assignment projection for route_run %', v_route_run_id
          USING ERRCODE = '23514';
      END IF;

      route_run_assignment_id := v_assignment_row.id;
      assignment_status := v_assignment_row.assignment_status;
      assignment_mode := v_assignment_row.assignment_mode;
      assignment_version := v_assignment_row.assignment_version;
      driver_user_id := v_assignment_row.driver_user_id;
      vehicle_id := v_assignment_row.vehicle_id;
      partner := COALESCE(v_assignment_row.partner, '{}'::jsonb);

      SELECT COUNT(*)::int
        INTO stop_task_count
        FROM public.route_stops rs
       WHERE rs.route_run_id = v_route_run_id;

      SELECT COUNT(*)::int
        INTO assigned_task_count
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
         AND t.assigned_to IS NOT NULL
         AND EXISTS (
           SELECT 1
             FROM public.route_stops rs
            WHERE rs.id = t.resource_id
              AND rs.route_run_id = v_route_run_id
         );

      created := FALSE;
      RETURN NEXT;
      RETURN;
    END IF;
  END IF;

  IF v_current_assignment.id IS NOT NULL THEN
    v_same_state :=
      v_current_assignment.assignment_status = v_requested_status
      AND v_current_assignment.assignment_mode = v_requested_mode
      AND v_current_assignment.driver_user_id IS NOT DISTINCT FROM v_requested_driver_user_id
      AND v_current_assignment.vehicle_id IS NOT DISTINCT FROM v_requested_vehicle_id
      AND COALESCE(v_current_assignment.partner, '{}'::jsonb) = COALESCE(v_requested_partner, '{}'::jsonb)
      AND COALESCE(v_current_assignment.notes, '') = COALESCE(v_requested_notes, '')
      AND COALESCE(v_current_assignment.metadata, '{}'::jsonb) = COALESCE(v_requested_metadata, '{}'::jsonb);
  END IF;

  IF v_same_state THEN
    route_run_assignment_id := v_current_assignment.id;
    assignment_status := v_current_assignment.assignment_status;
    assignment_mode := v_current_assignment.assignment_mode;
    assignment_version := v_current_assignment.assignment_version;
    driver_user_id := v_current_assignment.driver_user_id;
    vehicle_id := v_current_assignment.vehicle_id;
    partner := COALESCE(v_current_assignment.partner, '{}'::jsonb);

    SELECT COUNT(*)::int
      INTO stop_task_count
      FROM public.route_stops rs
     WHERE rs.route_run_id = v_route_run_id;

    SELECT COUNT(*)::int
      INTO assigned_task_count
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.resource_type = 'route_stop'
       AND tt.organization_id = v_route_run.organization_id
       AND tt.key = 'route_stop_execute'
       AND t.assigned_to IS NOT NULL
       AND EXISTS (
         SELECT 1
           FROM public.route_stops rs
          WHERE rs.id = t.resource_id
            AND rs.route_run_id = v_route_run_id
       );

    created := FALSE;
    RETURN NEXT;
    RETURN;
  END IF;

  IF v_requested_mode IN ('partner_fleet', 'alternate_capacity_pool') THEN
    PERFORM 1
      FROM public.tasks t
      JOIN public.task_types tt
        ON tt.id = t.task_type_id
     WHERE t.resource_type = 'route_stop'
       AND tt.organization_id = v_route_run.organization_id
       AND tt.key = 'route_stop_execute'
       AND t.assigned_to IS NOT NULL
       AND COALESCE(t.status, '') NOT IN ('completed', 'canceled')
       AND EXISTS (
         SELECT 1
           FROM public.route_stops rs
          WHERE rs.id = t.resource_id
            AND rs.route_run_id = v_route_run_id
       );
    IF FOUND THEN
      IF v_requested_mode = 'alternate_capacity_pool' THEN
        RAISE EXCEPTION 'assign_route_run_v1 alternate_capacity_pool handoff requires explicit downstream unassign flow before replacing assigned route_stop tasks'
          USING ERRCODE = '23514';
      END IF;

      RAISE EXCEPTION 'assign_route_run_v1 partner_fleet handoff requires explicit downstream unassign flow before replacing assigned route_stop tasks'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  v_service_claims := COALESCE(v_claims, '{}'::jsonb);
  IF jsonb_typeof(v_service_claims) IS DISTINCT FROM 'object' THEN
    v_service_claims := '{}'::jsonb;
  END IF;
  v_service_claims := (v_service_claims - 'sub') || jsonb_build_object('role', 'service_role');

  PERFORM set_config('app.actor_system', v_actor_system, true);
  PERFORM set_config('request.jwt.claim.sub', '', true);
  PERFORM set_config('request.jwt.claim.role', 'service_role', true);
  PERFORM set_config('request.jwt.claims', v_service_claims::text, true);

  BEGIN
    FOR v_stop IN
      SELECT rs.id, rs.client_id, rs.shipment_id
        FROM public.route_stops rs
       WHERE rs.route_run_id = v_route_run_id
       ORDER BY rs.sequence_order, rs.created_at, rs.id
    LOOP
      v_stop_task_total := v_stop_task_total + 1;

      SELECT t.id, t.assigned_to, t.status
        INTO v_task
        FROM public.tasks t
        JOIN public.task_types tt
          ON tt.id = t.task_type_id
       WHERE t.resource_type = 'route_stop'
         AND t.resource_id = v_stop.id
         AND tt.organization_id = v_route_run.organization_id
         AND tt.key = 'route_stop_execute'
       ORDER BY t.created_at DESC, t.id DESC
       LIMIT 1;

      IF v_task.id IS NULL THEN
        SELECT *
          INTO v_task_create
          FROM public.create_task_system_v1(
            jsonb_build_object(
              'task_type_key', 'route_stop_execute',
              'resource_type', 'route_stop',
              'resource_id', v_stop.id,
              'context', jsonb_strip_nulls(jsonb_build_object(
                'organization_id', v_route_run.organization_id,
                'route_run_id', v_route_run_id,
                'route_stop_id', v_stop.id,
                'shipment_id', v_stop.shipment_id,
                'client_id', v_stop.client_id
              )),
              'idempotency_key', format('route-run-assignment:create-task:%s:%s', v_route_run_id, v_stop.id),
              'metadata', jsonb_strip_nulls(jsonb_build_object(
                'route_run_id', v_route_run_id,
                'route_stop_id', v_stop.id,
                'assignment_mode', v_requested_mode
              )),
              'actor_system', v_actor_system
            )
          )
         LIMIT 1;

        v_task.id := v_task_create.task_id;
        v_task.assigned_to := NULL;
        v_task.status := 'open';
      END IF;

      IF v_requested_mode = 'internal_driver'
         AND v_task.id IS NOT NULL
         AND COALESCE(v_task.status, '') NOT IN ('completed', 'canceled')
         AND v_task.assigned_to IS DISTINCT FROM v_requested_driver_user_id THEN
        SELECT *
          INTO v_task_assign
          FROM public.assign_task_system_v1(
            v_task.id,
            v_requested_driver_user_id,
            format('route-run-assignment:assign-task:%s:%s:%s', v_route_run_id, COALESCE(v_current_assignment.assignment_version, 0) + 1, v_stop.id),
            v_requested_notes,
            v_actor_system
          )
         LIMIT 1;
      END IF;

      IF v_requested_mode = 'internal_driver'
         AND v_task.id IS NOT NULL
         AND COALESCE(v_task.status, '') NOT IN ('completed', 'canceled') THEN
        v_assigned_task_total := v_assigned_task_total + 1;
      END IF;
    END LOOP;
  EXCEPTION
    WHEN others THEN
      PERFORM set_config('request.jwt.claims', v_prev_claims, true);
      PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
      PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
      PERFORM set_config('app.actor_system', v_prev_actor_system, true);
      RAISE;
  END;

  PERFORM set_config('request.jwt.claims', v_prev_claims, true);
  PERFORM set_config('request.jwt.claim.role', v_prev_role, true);
  PERFORM set_config('request.jwt.claim.sub', v_prev_sub, true);
  PERFORM set_config('app.actor_system', v_prev_actor_system, true);

  v_next_version := COALESCE(v_current_assignment.assignment_version, 0) + 1;

  INSERT INTO public.route_run_assignments (
    organization_id,
    route_run_id,
    assignment_status,
    assignment_mode,
    driver_user_id,
    vehicle_id,
    partner,
    assignment_version,
    assigned_by_user_id,
    assigned_at,
    notes,
    metadata
  )
  VALUES (
    v_route_run.organization_id,
    v_route_run_id,
    v_requested_status,
    v_requested_mode,
    v_requested_driver_user_id,
    v_requested_vehicle_id,
    v_requested_partner,
    v_next_version,
    v_actor_user_id,
    now(),
    v_requested_notes,
    v_requested_metadata
  )
  ON CONFLICT ON CONSTRAINT route_run_assignments_route_run_id_key DO UPDATE
    SET assignment_status = EXCLUDED.assignment_status,
        assignment_mode = EXCLUDED.assignment_mode,
        driver_user_id = EXCLUDED.driver_user_id,
        vehicle_id = EXCLUDED.vehicle_id,
        partner = EXCLUDED.partner,
        assignment_version = EXCLUDED.assignment_version,
        assigned_by_user_id = EXCLUDED.assigned_by_user_id,
        assigned_at = EXCLUDED.assigned_at,
        notes = EXCLUDED.notes,
        metadata = EXCLUDED.metadata
  RETURNING *
    INTO v_assignment_row;

  v_decision_id := public.log_decision(
    p_organization_id := v_route_run.organization_id,
    p_decision_category := 'dispatch',
    p_resource_type := 'route_run',
    p_resource_id := v_route_run_id,
    p_decision_point := 'assign',
    p_decision_outcome := 'assigned',
    p_performed_by_system := v_actor_system,
    p_correlation_id := public.current_correlation_id(),
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'assignment_mode', v_requested_mode,
      'assignment_status', v_requested_status,
      'driver_user_id', v_requested_driver_user_id,
      'vehicle_id', v_requested_vehicle_id,
      'partner', v_requested_partner,
      'notes', v_requested_notes,
      'metadata', NULLIF(v_requested_metadata, '{}'::jsonb),
      'idempotency_key', v_idempotency_key,
      'settings_resolution_id', v_settings_resolution_id
    )),
    p_decision_reason := NULL,
    p_settings_resolution_id := v_settings_resolution_id
  );

  INSERT INTO public.route_run_assignment_events (
    organization_id,
    route_run_assignment_id,
    route_run_id,
    assignment_version,
    event_type,
    from_status,
    to_status,
    assignment_mode,
    driver_user_id,
    vehicle_id,
    partner,
    actor_user_id,
    actor_system,
    notes,
    payload,
    idempotency_key,
    decision_log_id
  )
  VALUES (
    v_route_run.organization_id,
    v_assignment_row.id,
    v_route_run_id,
    v_assignment_row.assignment_version,
    'assigned',
    v_current_assignment.assignment_status,
    v_assignment_row.assignment_status,
    v_assignment_row.assignment_mode,
    v_assignment_row.driver_user_id,
    v_assignment_row.vehicle_id,
    v_assignment_row.partner,
    v_actor_user_id,
    v_actor_system,
    v_assignment_row.notes,
    jsonb_strip_nulls(jsonb_build_object(
      'stop_task_count', v_stop_task_total,
      'assigned_task_count', v_assigned_task_total,
      'correlation_id', public.current_correlation_id(),
      'metadata', NULLIF(v_assignment_row.metadata, '{}'::jsonb),
      'settings_resolution_id', v_settings_resolution_id
    )),
    v_idempotency_key,
    v_decision_id
  );

  v_assignment_payload := jsonb_strip_nulls(
    jsonb_build_object(
      'route_run_assignment_id', v_assignment_row.id,
      'assignment_status', v_assignment_row.assignment_status,
      'assignment_mode', v_assignment_row.assignment_mode,
      'assignment_version', v_assignment_row.assignment_version,
      'driver_user_id', v_assignment_row.driver_user_id,
      'vehicle_id', v_assignment_row.vehicle_id,
      'partner', v_assignment_row.partner,
      'assigned_by_user_id', v_assignment_row.assigned_by_user_id,
      'assigned_at', v_assignment_row.assigned_at,
      'notes', v_assignment_row.notes,
      'metadata', NULLIF(v_assignment_row.metadata, '{}'::jsonb)
    )
  );

  UPDATE public.route_runs rr
     SET driver_user_id = v_assignment_row.driver_user_id,
         vehicle_id = v_assignment_row.vehicle_id,
         metadata = jsonb_set(COALESCE(rr.metadata, '{}'::jsonb), '{route_assignment}', v_assignment_payload, true)
   WHERE rr.id = v_route_run_id;

  UPDATE public.shipments s
     SET driver_user_id = v_assignment_row.driver_user_id,
         metadata = jsonb_set(COALESCE(s.metadata, '{}'::jsonb), '{route_assignment}', v_assignment_payload, true)
    FROM public.route_stops rs
   WHERE rs.route_run_id = v_route_run_id
     AND s.id = rs.shipment_id
     AND s.client_id = rs.client_id;

  route_run_id := v_assignment_row.route_run_id;
  route_run_assignment_id := v_assignment_row.id;
  assignment_status := v_assignment_row.assignment_status;
  assignment_mode := v_assignment_row.assignment_mode;
  assignment_version := v_assignment_row.assignment_version;
  driver_user_id := v_assignment_row.driver_user_id;
  vehicle_id := v_assignment_row.vehicle_id;
  partner := COALESCE(v_assignment_row.partner, '{}'::jsonb);
  stop_task_count := v_stop_task_total;
  assigned_task_count := v_assigned_task_total;
  created := TRUE;

  RETURN NEXT;
END;
$function$;

COMMENT ON FUNCTION public.assign_route_run_v1(JSONB)
  IS 'Canonical route-run assignment projection + event ledger. Internal-driver assignments sync route_stop_execute tasks through Tasks SSOT; partner and alternate-capacity assignments persist handoff provenance for executor/browser surfaces.';

-------------------------------------------------------------------------------
-- 4) Browser command schema: alternate capacity toggle
-------------------------------------------------------------------------------

DO $do$
DECLARE
  v_row RECORD;
  v_current JSONB := NULL;
  v_commands JSONB := '[]'::jsonb;
  v_next JSONB := NULL;
  v_command JSONB := NULL;
  v_required JSONB := '[]'::jsonb;
BEGIN
  FOR v_row IN
    SELECT
      s.id,
      s.settings_version_id,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'ui_command_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_commands := COALESCE(v_current->'commands', '[]'::jsonb);
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_commands := (
      SELECT jsonb_agg(
        CASE
          WHEN value->>'key' IN ('routes.assign', 'routes.reassign') THEN
            jsonb_set(
              jsonb_set(
                value,
                '{input_schema,properties}',
                COALESCE(value#>'{input_schema,properties}', '{}'::jsonb)
                || jsonb_build_object(
                  'use_alternate_capacity', jsonb_build_object('type', 'boolean'),
                  'assignment_mode', jsonb_build_object(
                    'type', 'string',
                    'enum', jsonb_build_array('internal_driver', 'partner_fleet', 'alternate_capacity_pool')
                  )
                ),
                TRUE
              ),
              '{input_schema,fields}',
              CASE
                WHEN value->>'key' = 'routes.reassign' THEN
                  jsonb_build_array(
                    jsonb_build_object(
                      'key', 'driver_user_id',
                      'label', 'Driver user ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'vehicle_id',
                      'label', 'Vehicle ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'partner_id',
                      'label', 'Partner ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'partner_name',
                      'label', 'Partner name',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'assignment_mode',
                      'label', 'Assignment mode',
                      'type', 'text',
                      'required', TRUE,
                      'default_value', 'internal_driver',
                      'placeholder', 'internal_driver | partner_fleet | alternate_capacity_pool'
                    ),
                    jsonb_build_object(
                      'key', 'reassignment_reason',
                      'label', 'Reassignment reason',
                      'type', 'textarea',
                      'required', TRUE,
                      'placeholder', 'Explain why the route needs a new assignee'
                    ),
                    jsonb_build_object(
                      'key', 'notes',
                      'label', 'Assignment notes',
                      'type', 'textarea'
                    )
                  )
                ELSE
                  jsonb_build_array(
                    jsonb_build_object(
                      'key', 'driver_user_id',
                      'label', 'Driver user ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'vehicle_id',
                      'label', 'Vehicle ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'partner_id',
                      'label', 'Partner ID',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'partner_name',
                      'label', 'Partner name',
                      'type', 'text'
                    ),
                    jsonb_build_object(
                      'key', 'assignment_mode',
                      'label', 'Assignment mode',
                      'type', 'text',
                      'required', TRUE,
                      'default_value', 'internal_driver',
                      'placeholder', 'internal_driver | partner_fleet | alternate_capacity_pool'
                    ),
                    jsonb_build_object(
                      'key', 'notes',
                      'label', 'Assignment notes',
                      'type', 'textarea'
                    )
                  )
              END,
              TRUE
            )
          ELSE value
        END
      )
      FROM jsonb_array_elements(v_commands) AS item(value)
    );

    v_next := jsonb_set(v_current, '{commands}', COALESCE(v_commands, '[]'::jsonb), TRUE);

    UPDATE public.settings_versions
       SET value = v_next,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    UPDATE public.settings
       SET cached_value = v_next,
           last_updated = now()
     WHERE id = v_row.id;
  END LOOP;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604081900_uc079_route_run_alternate_capacity_pool_v1'));
COMMIT;
