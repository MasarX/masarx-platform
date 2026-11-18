-- Spec-Issue: Phase B6 - Catalog RPC contract: lookup_definition_create_v1
-- Step: B6-RPC-7
-- Capability: lookups.write (elevated to platform users for global scope)
--
-- Architectural decision: lookup_definitions originally had no organization_id
-- (system seed table). Foundation migration added organization_id + scope_type
-- for tenant-scoped extension. Behavior:
--   * scope_type='tenant' (default): caller's org becomes owner; lookups.write required.
--   * scope_type='global': only platform users may create global definitions.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280207_lookup_definition_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.lookup_definition_create_v1(p_args jsonb)
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
  v_resource_id UUID;
  v_category TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'category', '')), ''));
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_owner_role TEXT := NULLIF(btrim(COALESCE(p_args->>'owner_role', '')), '');
  v_approval_policy TEXT := NULLIF(btrim(COALESCE(p_args->>'approval_policy', '')), '');
  v_is_mutable BOOLEAN := COALESCE((p_args->>'is_mutable')::boolean, TRUE);
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant'));
  v_target_org UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'lookup_definition_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('lookups.write');

  IF v_category IS NULL THEN
    RAISE EXCEPTION 'lookup_definition_create_v1 requires category'
      USING ERRCODE = '23502';
  END IF;
  IF v_scope_type NOT IN ('global', 'tenant') THEN
    RAISE EXCEPTION 'lookup_definition_create_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_type = 'global' THEN
    -- Global definitions are platform-only.
    IF NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'lookup_definition_create_v1 scope=global requires platform user'
        USING ERRCODE = '42501';
    END IF;
    v_target_org := NULL;
  ELSE
    v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'lookup_definition_create_v1 cannot resolve target organization'
        USING ERRCODE = '23502';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'lookup_definition_create_v1 organization_id outside tenant scope'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  INSERT INTO public.lookup_definitions (
    category, description, owner_role, approval_policy, is_mutable,
    organization_id, scope_type, created_by
  ) VALUES (
    v_category, v_description, v_owner_role, v_approval_policy, v_is_mutable,
    v_target_org, v_scope_type, v_user_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'lookup_definitions.create', 'lookup_definition', v_resource_id,
    'lookup_definition_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object('category', v_category, 'scope_type', v_scope_type)),
    'lookup_definition_create_v1', v_correlation_id::uuid
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'lookup_definition.created', 'lookup_definition', v_resource_id,
      jsonb_build_object('category', v_category, 'scope_type', v_scope_type),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'lookup_definition_id', v_resource_id,
    'scope_type', v_scope_type,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_definition_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_definition_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_definition_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.lookup_definition_create_v1(jsonb)
  IS 'Canonical write RPC: insert lookup_definitions row (scope_type tenant|global). Capability: lookups.write (global scope additionally requires platform user).';

SELECT pg_advisory_unlock(hashtext('202604280207_lookup_definition_create_v1'));
COMMIT;
