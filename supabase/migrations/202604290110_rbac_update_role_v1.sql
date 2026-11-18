-- Spec-Issue: Wave 6 W6-2 RBAC role-management lifecycle (Phase E3 / IDENTITY P0)
-- Step: B-RPC-RBAC-Update-Role
-- Capability: access_policy.approve
--
-- Behavior: canonical update RPC for public.rbac_roles. Loads the row by
-- role_id, enforces tenant scope (caller's org or platform user), then
-- partially mutates only explicitly provided keys (name, description,
-- is_active, metadata). The role key is immutable (carried by FE; updates
-- only mutate display fields).
--
-- Append-only audit: writes a decision_log row + emits a domain_event on
-- successful update. Returns canonical envelope
-- { ok, rbac_role_id, action, correlation_id, settings_resolution_id }.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604290110_rbac_update_role_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.rbac_update_role_v1(p_args jsonb)
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
  v_role_id UUID := NULLIF(p_args->>'role_id', '')::uuid;
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_description TEXT := CASE WHEN p_args ? 'description'
                              THEN NULLIF(btrim(COALESCE(p_args->>'description', '')), '')
                              ELSE NULL END;
  v_description_present BOOLEAN := (p_args ? 'description');
  v_is_active_present BOOLEAN := (p_args ? 'is_active');
  v_is_active BOOLEAN := COALESCE((p_args->>'is_active')::boolean, TRUE);
  v_metadata_present BOOLEAN := (p_args ? 'metadata');
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_before public.rbac_roles%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'rbac_update_role_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('access_policy.approve');

  IF v_role_id IS NULL THEN
    RAISE EXCEPTION 'rbac_update_role_v1 requires role_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.rbac_roles WHERE id = v_role_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'rbac_update_role_v1 role % not found', v_role_id
      USING ERRCODE = '23503';
  END IF;
  IF v_org_id IS NOT NULL
     AND v_before.organization_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'rbac_update_role_v1 role % outside tenant scope', v_role_id
      USING ERRCODE = '42501';
  END IF;

  UPDATE public.rbac_roles
     SET name = COALESCE(v_name, name),
         description = CASE WHEN v_description_present THEN v_description ELSE description END,
         is_active = CASE WHEN v_is_active_present THEN v_is_active ELSE is_active END,
         metadata = CASE WHEN v_metadata_present THEN v_metadata ELSE metadata END,
         updated_at = now()
   WHERE id = v_role_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_before.organization_id,
    'access_policy.rbac_update_role', 'rbac_role', v_role_id,
    'rbac_update_role_v1', 'updated',
    jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'description', CASE WHEN v_description_present THEN to_jsonb(v_description) ELSE NULL END,
      'is_active', CASE WHEN v_is_active_present THEN to_jsonb(v_is_active) ELSE NULL END,
      'metadata_changed', v_metadata_present
    )),
    'rbac_update_role_v1', v_correlation_id::uuid
  );

  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_before.organization_id, 'rbac_role.updated', 'rbac_role', v_role_id,
    jsonb_strip_nulls(jsonb_build_object(
      'name', v_name,
      'is_active', CASE WHEN v_is_active_present THEN to_jsonb(v_is_active) ELSE NULL END
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'rbac_role_id', v_role_id,
    'action', 'updated',
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.rbac_update_role_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.rbac_update_role_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.rbac_update_role_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.rbac_update_role_v1(jsonb)
  IS 'Canonical write RPC: update public.rbac_roles row (org-scoped). Capability: access_policy.approve. Partial update — only provided keys are mutated. Role key is immutable.';

SELECT pg_advisory_unlock(hashtext('202604290110_rbac_update_role_v1'));
COMMIT;
