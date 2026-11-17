-- Spec-Issue: #2067 / Step: UC066
-- Migration: Canonical warehouse transfer manifest create contract
-- Date: 2026-04-04
--
-- Purpose:
-- - Provide an authoritative manifest-create RPC for warehouse transfers.
-- - Reuse transfer_code as the natural idempotency key for draft manifest creation.
-- - Expose the create contract through the api schema so browser/server UI clients
--   can create manifests without raw table inserts.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604042000_warehouse_transfer_manifest_create_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.create_warehouse_transfer_manifest_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_input JSONB := COALESCE(p_input, '{}'::jsonb);
  v_user_id UUID := auth.uid();
  v_service_role BOOLEAN := public.request_is_service_role_v1();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();

  v_org_id UUID := NULL;
  v_current_org_id UUID := public.current_user_org_id();
  v_from_branch_id UUID := NULL;
  v_to_branch_id UUID := NULL;
  v_from_branch_org_id UUID := NULL;
  v_to_branch_org_id UUID := NULL;
  v_transfer_code TEXT := NULL;
  v_planned_dispatch_at TIMESTAMPTZ := NULL;
  v_planned_receive_at TIMESTAMPTZ := NULL;
  v_metadata JSONB := '{}'::jsonb;

  v_item JSONB;
  v_shipment_id UUID := NULL;
  v_shipment_ids UUID[] := '{}'::uuid[];
  v_requested_shipment_ids_sorted UUID[] := '{}'::uuid[];
  v_found_shipment_ids UUID[] := '{}'::uuid[];
  v_existing_transfer_shipment_ids UUID[] := '{}'::uuid[];
  v_requested_shipment_count INT := 0;
  v_found_shipment_count INT := 0;
  v_manifest_count INT := 0;

  v_existing_transfer public.warehouse_transfers%ROWTYPE;
  v_transfer_id UUID := NULL;
  v_created BOOLEAN := FALSE;
BEGIN
  IF jsonb_typeof(v_input) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 expects JSON object input'
      USING ERRCODE = '23514';
  END IF;

  BEGIN
    v_org_id := NULLIF(v_input->>'organization_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_org_id := NULL;
  END;

  BEGIN
    v_from_branch_id := NULLIF(v_input->>'from_branch_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_from_branch_id := NULL;
  END;

  BEGIN
    v_to_branch_id := NULLIF(v_input->>'to_branch_id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_to_branch_id := NULL;
  END;

  BEGIN
    v_planned_dispatch_at := NULLIF(v_input->>'planned_dispatch_at', '')::timestamptz;
  EXCEPTION
    WHEN others THEN
      v_planned_dispatch_at := NULL;
  END;

  BEGIN
    v_planned_receive_at := NULLIF(v_input->>'planned_receive_at', '')::timestamptz;
  EXCEPTION
    WHEN others THEN
      v_planned_receive_at := NULL;
  END;

  v_transfer_code := NULLIF(btrim(COALESCE(v_input->>'transfer_code', '')), '');
  v_metadata := COALESCE(v_input->'metadata', '{}'::jsonb);
  IF jsonb_typeof(v_metadata) IS DISTINCT FROM 'object' THEN
    v_metadata := '{}'::jsonb;
  END IF;

  IF NOT v_service_role THEN
    IF v_user_id IS NULL THEN
      RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires an authenticated user'
        USING ERRCODE = '42501';
    END IF;

    IF NOT v_is_platform AND v_scope_type IS DISTINCT FROM 'tenant' THEN
      RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires tenant/platform write scope'
        USING ERRCODE = '42501';
    END IF;

    PERFORM public.assert_capability_v1('warehouse_transfers.write', v_scope_type, v_scope_id);

    IF v_org_id IS NULL THEN
      v_org_id := v_current_org_id;
    END IF;

    IF NOT v_is_platform AND v_current_org_id IS DISTINCT FROM v_org_id THEN
      RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 organization mismatch for current tenant scope'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_org_id IS NULL THEN
    v_org_id := v_current_org_id;
  END IF;

  IF v_from_branch_id IS NULL OR v_to_branch_id IS NULL THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires from_branch_id and to_branch_id'
      USING ERRCODE = '23514';
  END IF;

  IF v_transfer_code IS NULL THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires transfer_code'
      USING ERRCODE = '23514';
  END IF;

  SELECT b.organization_id
    INTO v_from_branch_org_id
    FROM public.branches b
   WHERE b.id = v_from_branch_id
   LIMIT 1;

  IF v_from_branch_org_id IS NULL THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 from_branch not found'
      USING ERRCODE = '23503';
  END IF;

  SELECT b.organization_id
    INTO v_to_branch_org_id
    FROM public.branches b
   WHERE b.id = v_to_branch_id
   LIMIT 1;

  IF v_to_branch_org_id IS NULL THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 to_branch not found'
      USING ERRCODE = '23503';
  END IF;

  IF v_from_branch_org_id IS DISTINCT FROM v_to_branch_org_id THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 branches must belong to the same organization'
      USING ERRCODE = '23514';
  END IF;

  IF v_org_id IS NULL THEN
    v_org_id := v_from_branch_org_id;
  END IF;

  IF v_org_id IS DISTINCT FROM v_from_branch_org_id THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 organization mismatch for branches'
      USING ERRCODE = '23514';
  END IF;

  IF jsonb_typeof(v_input->'shipment_ids') IS DISTINCT FROM 'array' THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires shipment_ids array'
      USING ERRCODE = '23514';
  END IF;

  FOR v_item IN
    SELECT value
      FROM jsonb_array_elements(v_input->'shipment_ids') AS t(value)
  LOOP
    BEGIN
      IF jsonb_typeof(v_item) = 'string' THEN
        v_shipment_id := NULLIF(trim(both '"' FROM v_item::text), '')::UUID;
      ELSE
        v_shipment_id := NULLIF(v_item->>'shipment_id', '')::UUID;
      END IF;
    EXCEPTION
      WHEN others THEN
        v_shipment_id := NULL;
    END;

    IF v_shipment_id IS NULL THEN
      RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 shipment_ids must contain UUID values'
        USING ERRCODE = '23514';
    END IF;

    IF NOT (v_shipment_id = ANY(v_shipment_ids)) THEN
      v_shipment_ids := array_append(v_shipment_ids, v_shipment_id);
    END IF;
  END LOOP;

  v_requested_shipment_count := COALESCE(array_length(v_shipment_ids, 1), 0);
  IF v_requested_shipment_count < 1 THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 requires shipment_ids'
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(array_agg(x ORDER BY x), '{}'::uuid[])
    INTO v_requested_shipment_ids_sorted
    FROM unnest(v_shipment_ids) AS x;

  SELECT COALESCE(COUNT(*), 0)::INT,
         COALESCE(array_agg(s.id ORDER BY s.id), '{}'::uuid[])
    INTO v_found_shipment_count, v_found_shipment_ids
    FROM public.shipments s
   WHERE s.organization_id = v_org_id
     AND s.id = ANY(v_shipment_ids);

  IF v_found_shipment_count <> v_requested_shipment_count
     OR v_found_shipment_ids IS DISTINCT FROM v_requested_shipment_ids_sorted THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 shipment_ids must resolve to organization shipments'
      USING ERRCODE = '23514';
  END IF;

  SELECT *
    INTO v_existing_transfer
    FROM public.warehouse_transfers wt
   WHERE wt.organization_id = v_org_id
     AND wt.transfer_code = v_transfer_code
   LIMIT 1;

  IF v_existing_transfer.id IS NULL THEN
    BEGIN
      INSERT INTO public.warehouse_transfers (
        organization_id,
        from_branch_id,
        to_branch_id,
        status,
        transfer_code,
        created_by_user_id,
        planned_dispatch_at,
        planned_receive_at,
        metadata
      )
      VALUES (
        v_org_id,
        v_from_branch_id,
        v_to_branch_id,
        'draft',
        v_transfer_code,
        v_user_id,
        v_planned_dispatch_at,
        v_planned_receive_at,
        jsonb_strip_nulls(
          v_metadata
          || jsonb_build_object(
            'source', 'warehouse_transfer_manifest.create',
            'requested_by', v_user_id,
            'transfer_code', v_transfer_code
          )
        )
      )
      RETURNING id INTO v_transfer_id;

      v_created := TRUE;
    EXCEPTION
      WHEN unique_violation THEN
        SELECT *
          INTO v_existing_transfer
          FROM public.warehouse_transfers wt
         WHERE wt.organization_id = v_org_id
           AND wt.transfer_code = v_transfer_code
         LIMIT 1;
    END;
  END IF;

  IF NOT v_created THEN
    IF v_existing_transfer.id IS NULL THEN
      RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 could not resolve existing transfer manifest'
        USING ERRCODE = '23514';
    END IF;

    IF v_existing_transfer.from_branch_id IS DISTINCT FROM v_from_branch_id
       OR v_existing_transfer.to_branch_id IS DISTINCT FROM v_to_branch_id
       OR v_existing_transfer.planned_dispatch_at IS DISTINCT FROM v_planned_dispatch_at
       OR v_existing_transfer.planned_receive_at IS DISTINCT FROM v_planned_receive_at THEN
      RAISE EXCEPTION 'warehouse_transfer_manifest_conflict' USING ERRCODE = 'P0001';
    END IF;

    SELECT COALESCE(array_agg(wti.shipment_id ORDER BY wti.shipment_id), '{}'::uuid[])
      INTO v_existing_transfer_shipment_ids
      FROM public.warehouse_transfer_items wti
     WHERE wti.transfer_id = v_existing_transfer.id;

    IF v_existing_transfer_shipment_ids IS DISTINCT FROM v_requested_shipment_ids_sorted THEN
      RAISE EXCEPTION 'warehouse_transfer_manifest_conflict' USING ERRCODE = 'P0001';
    END IF;

    RETURN jsonb_build_object(
      'status', 'transfer_manifest_reused',
      'created', FALSE,
      'operation', 'reused',
      'transfer_id', v_existing_transfer.id,
      'warehouse_transfer_id', v_existing_transfer.id,
      'transfer_code', v_existing_transfer.transfer_code,
      'transfer_status', v_existing_transfer.status,
      'shipment_count', COALESCE(array_length(v_existing_transfer_shipment_ids, 1), 0)
    );
  END IF;

  INSERT INTO public.warehouse_transfer_items (
    organization_id,
    transfer_id,
    client_id,
    shipment_id,
    added_by_user_id,
    metadata
  )
  SELECT
    v_org_id,
    v_transfer_id,
    s.client_id,
    s.id,
    v_user_id,
    jsonb_strip_nulls(
      jsonb_build_object(
        'source', 'warehouse_transfer_manifest.create',
        'transfer_code', v_transfer_code,
        'requested_by', v_user_id
      )
    )
    FROM public.shipments s
   WHERE s.organization_id = v_org_id
     AND s.id = ANY(v_shipment_ids)
  ON CONFLICT (transfer_id, client_id, shipment_id) DO NOTHING;

  SELECT COUNT(*)::INT
    INTO v_manifest_count
    FROM public.warehouse_transfer_items wti
   WHERE wti.transfer_id = v_transfer_id;

  IF v_manifest_count <> v_requested_shipment_count THEN
    RAISE EXCEPTION 'create_warehouse_transfer_manifest_v1 manifest membership mismatch'
      USING ERRCODE = '23514';
  END IF;

  RETURN jsonb_build_object(
    'status', 'transfer_manifest_created',
    'created', TRUE,
    'operation', 'inserted',
    'transfer_id', v_transfer_id,
    'warehouse_transfer_id', v_transfer_id,
    'transfer_code', v_transfer_code,
    'transfer_status', 'draft',
    'shipment_count', v_manifest_count
  );
END;
$function$;

COMMENT ON FUNCTION public.create_warehouse_transfer_manifest_v1(JSONB)
  IS 'Create or reuse a draft warehouse transfer manifest from branch + shipment membership input using transfer_code as the natural idempotency key.';

REVOKE ALL ON FUNCTION public.create_warehouse_transfer_manifest_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.create_warehouse_transfer_manifest_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.create_warehouse_transfer_manifest_v1(JSONB) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.create_warehouse_transfer_manifest_v1(
  p_input JSONB
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.create_warehouse_transfer_manifest_v1(p_input);
$function$;

COMMENT ON FUNCTION api.create_warehouse_transfer_manifest_v1(JSONB)
  IS 'api-schema wrapper for the canonical warehouse transfer manifest create contract.';

REVOKE ALL ON FUNCTION api.create_warehouse_transfer_manifest_v1(JSONB) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION api.create_warehouse_transfer_manifest_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604042000_warehouse_transfer_manifest_create_v1'));
COMMIT;
