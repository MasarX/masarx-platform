-- Spec-Issue: Wave 6 W6-2 RBAC role-management lifecycle (Phase E3 / IDENTITY P0)
-- Step: B-RPC-RBAC-Create-Role
-- Capability: access_policy.approve
--
-- Behavior: canonical create RPC for public.rbac_roles. Org-scoped insert with
-- duplicate-key idempotence (unique on organization_id + key). Required keys:
--   * key (lowercase, snake_case)
--   * name
-- Optional: description, is_active (default TRUE), metadata, organization_id
-- (defaults to caller's org via current_user_org_id; platform users may target
-- another org). On collision (existing key in org) the RPC returns the
-- existing role_id with idempotent_no_op=true (no mutation).
--
-- Append-only audit: writes a decision_log row + emits a domain_event on each
-- successful create (idempotent path included). Returns canonical envelope
-- { ok, rbac_role_id, action, idempotent_no_op, correlation_id,
--   settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604290100_rbac_create_role_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.rbac_create_role_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_target_org UUID;
  v_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'key', '')), ''));
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_is_active BOOLEAN := COALESCE((p_args->>'is_active')::boolean, TRUE);
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_role_id UUID;
  v_existing_id UUID;
  v_action TEXT;
  v_idempotent BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'rbac_create_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'rbac_create_role_v1 requires key'
      USING ERRCODE = '23502';
  END IF;
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'rbac_create_role_v1 requires name'
      USING ERRCODE = '23502';
  END IF;

  v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
  IF v_target_org IS NULL THEN
    RAISE EXCEPTION 'rbac_create_role_v1 cannot resolve target organization'
      USING ERRCODE = '23502';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'rbac_create_role_v1 organization_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  -- Idempotent path: if a role with this (org, key) already exists, return it.
  SELECT id INTO v_existing_id
    FROM public.rbac_roles
   WHERE organization_id = v_target_org
     AND key = v_key
   LIMIT 1;

  IF v_existing_id IS NOT NULL THEN
    v_role_id := v_existing_id;
    v_action := 'noop';
    v_idempotent := TRUE;
  ELSE
    INSERT INTO public.rbac_roles (
      organization_id, key, name, description, is_active, metadata
    ) VALUES (
      v_target_org, v_key, v_name, v_description, v_is_active, v_metadata
    )
    RETURNING id INTO v_role_id;
    v_action := 'created';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_target_org,
    'access_policy.rbac_create_role', 'rbac_role', v_role_id,
    'rbac_create_role_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'key', v_key,
      'name', v_name,
      'description', v_description,
      'is_active', v_is_active,
      'idempotent_no_op', v_idempotent
    )),
    'rbac_create_role_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_target_org, 'rbac_role.' || v_action, 'rbac_role', v_role_id,
    jsonb_strip_nulls(jsonb_build_object(
      'key', v_key,
      'name', v_name,
      'is_active', v_is_active,
      'idempotent_no_op', v_idempotent
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_role_id', v_role_id,
    'action', v_action,
    'idempotent_no_op', v_idempotent,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.rbac_create_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_create_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_create_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_create_role_v1(jsonb)
  IS 'Canonical write RPC: create public.rbac_roles row (org-scoped). Capability: access_policy.approve. Idempotent on (organization_id, key) — returns existing role_id with idempotent_no_op=true if already present.';

SELECT pg_advisory_unlock(hashtext('202604290100_rbac_create_role_v1'));
COMMIT;
