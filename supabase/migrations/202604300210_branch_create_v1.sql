-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S02
-- Migration: branch_create_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Purpose:
--   Canonical write RPC: insert public.branches row + decision_log + domain_event.
--   Replaces the FE phaseC6Rpc shim path (NETWORK gap closure).
--
-- Args (jsonb):
--   { name (text, required), code (text, optional auto), branch_type (text),
--     timezone (text), address (jsonb|text), operating_hours (jsonb),
--     coordinates (text — POINT WKT, optional), is_active (boolean, default true),
--     metadata (jsonb), organization_id (uuid, defaults to caller org) }
-- Envelope: { ok, branch_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300210_branch_create_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_create_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_target_org UUID := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_caller_org_id);
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_code TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'code', '')), ''));
  v_branch_type TEXT := NULLIF(btrim(COALESCE(p_args->>'branch_type', '')), '');
  v_timezone TEXT := NULLIF(btrim(COALESCE(p_args->>'timezone', '')), '');
  v_address JSONB := COALESCE(p_args->'address', NULL);
  v_address_text TEXT := NULLIF(btrim(COALESCE(p_args->>'address', '')), '');
  v_operating_hours JSONB := COALESCE(p_args->'operating_hours', NULL);
  v_metadata JSONB := COALESCE(p_args->'metadata', NULL);
  v_is_active BOOLEAN := COALESCE((p_args->>'is_active')::boolean, TRUE);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_target_org);

  IF v_name IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires name' USING ERRCODE = '23502';
  END IF;
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'branch_create_v1 requires organization_id (caller has no scope)'
      USING ERRCODE = '23502';
  END IF;

  -- Tenant guard
  IF v_caller_org_id IS NOT NULL
     AND v_target_org <> v_caller_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'branch_create_v1 organization % outside tenant scope', v_target_org
      USING ERRCODE = '42501';
  END IF;

  -- Auto-derive code if absent: lower-trimmed name w/ unique suffix
  IF v_code IS NULL THEN
    v_code := regexp_replace(lower(v_name), '[^a-z0-9]+', '-', 'g');
    v_code := regexp_replace(v_code, '(^-|-$)', '', 'g');
    IF v_code IS NULL OR v_code = '' THEN
      v_code := 'branch';
    END IF;
    -- Ensure uniqueness within org
    WHILE EXISTS (SELECT 1 FROM public.branches b WHERE b.organization_id = v_target_org AND b.code = v_code) LOOP
      v_code := v_code || '-' || substr(md5(random()::text || clock_timestamp()::text), 1, 4);
    END LOOP;
  END IF;

  -- If address came as a string, wrap into a JSONB object
  IF v_address IS NULL AND v_address_text IS NOT NULL THEN
    v_address := jsonb_build_object('formatted', v_address_text);
  END IF;

  INSERT INTO public.branches (
    organization_id, code, name, branch_type, timezone,
    operating_hours, address, is_active, metadata
  ) VALUES (
    v_target_org, v_code, v_name, v_branch_type, v_timezone,
    v_operating_hours, v_address, v_is_active, v_metadata
  ) RETURNING id INTO v_branch_id;

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_target_org, 'branch.created', 'branch', v_branch_id, v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'branch_id', v_branch_id,
      'organization_id', v_target_org,
      'name', v_name,
      'code', v_code,
      'branch_type', v_branch_type,
      'timezone', v_timezone
    )),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_target_org,
    p_decision_category := 'branches.create',
    p_resource_type := 'branch',
    p_resource_id := v_branch_id,
    p_decision_point := 'branch_create_v1',
    p_decision_outcome := 'created',
    p_performed_by_system := 'branch_create_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'code', v_code,
      'branch_type', v_branch_type,
      'timezone', v_timezone,
      'is_active', v_is_active
    ))
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_id', v_branch_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_create_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_create_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_create_v1(JSONB) IS
  'NETWORK W8 canonical write RPC: insert public.branches row + decision_log + domain_event. Capability: branches.write.';

SELECT pg_advisory_unlock(hashtext('202604300210_branch_create_v1'));
COMMIT;
