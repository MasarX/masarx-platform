-- Plan: PLAN-202604-b06-route-run-assignment / Step: E07
-- Migration: UC079 alternate capacity request contract fix v1
-- Purpose:
--   - Restore the canonical marketplace request contract for alternate-capacity
--     resolution while keeping sender scope sourced from shipments.sender_id.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604092060_uc079_alternate_capacity_request_contract_fix_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
    s.sender_id
    INTO v_first_stop
    FROM public.route_stops rs
    LEFT JOIN public.shipments s
      ON s.id = rs.shipment_id
     AND s.client_id = rs.client_id
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

  IF cardinality(v_allowed_demand_classes) > 0
     AND NOT (v_demand_class = ANY (v_allowed_demand_classes)) THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 demand_class % is not allowed for route_run %', COALESCE(v_demand_class, 'null'), p_route_run_id
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_marketplace_request_id := NULLIF(
      COALESCE(
        public.route_assignment_jsonpath_first_text_v1(
          COALESCE(v_route_run.metadata, '{}'::jsonb),
          v_alt_policy->'route_metadata_marketplace_request_id_paths'
        ),
        public.route_assignment_jsonpath_first_text_v1(
          COALESCE(v_first_stop.shipment_metadata, '{}'::jsonb),
          v_alt_policy->'shipment_metadata_marketplace_request_id_paths'
        )
      ),
      ''
    )::uuid;
  EXCEPTION
    WHEN others THEN
      v_marketplace_request_id := NULL;
  END;

  IF v_marketplace_request_id IS NULL THEN
    RAISE EXCEPTION 'route_run_resolve_alternate_capacity_v1 could not resolve marketplace_request_id for route_run %', p_route_run_id
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
  IS 'Resolves row-driven alternate capacity assignments from marketplace private pools using the canonical route assignment policy ladder.';

REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM anon;
REVOKE ALL ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.route_run_resolve_alternate_capacity_v1(UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202604092060_uc079_alternate_capacity_request_contract_fix_v1'));
COMMIT;
