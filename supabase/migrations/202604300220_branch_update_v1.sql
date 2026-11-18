-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S03
-- Migration: branch_update_v1
-- Capability: branches.write
-- Date: 2026-04-30
--
-- Args (jsonb):
--   { branch_id (uuid, required), patch (jsonb, required) }
-- Patch keys: name, code, branch_type, timezone, address, operating_hours,
-- is_active, metadata
-- Envelope: { ok, branch_id, correlation_id, settings_resolution_id }

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300220_branch_update_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.branch_update_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_branch_id UUID;
  v_branch public.branches%ROWTYPE;
  v_patch JSONB := COALESCE(p_args->'patch', '{}'::jsonb);
  v_changed JSONB := '{}'::jsonb;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  v_branch_id := NULLIF(p_args->>'branch_id', '')::uuid;
  IF v_branch_id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 requires branch_id' USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_branch FROM public.branches WHERE id = v_branch_id FOR UPDATE;
  IF v_branch.id IS NULL THEN
    RAISE EXCEPTION 'branch_update_v1 branch % not found', v_branch_id USING ERRCODE = '23503';
  END IF;

  PERFORM public.assert_capability_v1('branches.write', 'tenant', v_branch.organization_id);

  IF NOT public.is_platform_user() AND v_branch.organization_id <> public.current_user_org_id() THEN
    RAISE EXCEPTION 'branch_update_v1 branch % outside tenant scope', v_branch_id USING ERRCODE = '42501';
  END IF;

  UPDATE public.branches
     SET name = COALESCE(NULLIF(btrim(v_patch->>'name'), ''), name),
         code = COALESCE(lower(NULLIF(btrim(v_patch->>'code'), '')), code),
         branch_type = COALESCE(NULLIF(btrim(v_patch->>'branch_type'), ''), branch_type),
         timezone = COALESCE(NULLIF(btrim(v_patch->>'timezone'), ''), timezone),
         address = COALESCE(v_patch->'address', address),
         operating_hours = COALESCE(v_patch->'operating_hours', operating_hours),
         is_active = COALESCE((v_patch->>'is_active')::boolean, is_active),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(v_patch->'metadata', '{}'::jsonb),
         updated_at = now()
   WHERE id = v_branch_id;

  v_changed := jsonb_strip_nulls(jsonb_build_object(
    'name', NULLIF(btrim(v_patch->>'name'), ''),
    'code', NULLIF(btrim(v_patch->>'code'), ''),
    'branch_type', NULLIF(btrim(v_patch->>'branch_type'), ''),
    'timezone', NULLIF(btrim(v_patch->>'timezone'), ''),
    'is_active', v_patch->'is_active'
  ));

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, correlation_id, payload, status
  ) VALUES (
    v_branch.organization_id, 'branch.updated', 'branch', v_branch_id, v_correlation_id,
    jsonb_build_object('branch_id', v_branch_id, 'changed', v_changed),
    'pending'
  );

  v_decision_log_id := public.log_decision(
    p_organization_id := v_branch.organization_id,
    p_decision_category := 'branches.update',
    p_resource_type := 'branch',
    p_resource_id := v_branch_id,
    p_decision_point := 'branch_update_v1',
    p_decision_outcome := 'updated',
    p_performed_by_system := 'branch_update_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_build_object('patch', v_patch)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'branch_id', v_branch_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_log_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.branch_update_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.branch_update_v1(JSONB) TO authenticated, service_role;

COMMENT ON FUNCTION public.branch_update_v1(JSONB) IS
  'NETWORK W8 canonical write RPC: patch public.branches row + decision_log + domain_event. Capability: branches.write.';

SELECT pg_advisory_unlock(hashtext('202604300220_branch_update_v1'));
COMMIT;
