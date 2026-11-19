-- Spec-Issue: Phase B6 - Catalog RPC contract: lookup_value_create_v1
-- Step: B6-RPC-8
-- Capability: lookups.write

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280208_lookup_value_create_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.lookup_value_create_v1(p_args jsonb)
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
  v_lookup_definition_id UUID := NULLIF(p_args->>'lookup_definition_id', '')::uuid;
  v_value TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'value', '')), ''));
  v_label TEXT := NULLIF(btrim(COALESCE(p_args->>'label', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_sort_order INTEGER := NULLIF(p_args->>'sort_order', '')::int;
  v_metadata JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_status TEXT := COALESCE(NULLIF(btrim(p_args->>'status'), ''), 'draft');
  v_def_org UUID;
  v_def_scope TEXT;
  v_def_mutable BOOLEAN;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'lookup_value_create_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('lookups.write');

  IF v_lookup_definition_id IS NULL OR v_value IS NULL OR v_label IS NULL THEN
    RAISE EXCEPTION 'lookup_value_create_v1 requires lookup_definition_id, value, label'
      USING ERRCODE = '23502';
  END IF;
  IF v_status NOT IN ('draft', 'active', 'archived') THEN
    RAISE EXCEPTION 'lookup_value_create_v1 invalid status %', v_status
      USING ERRCODE = '22023';
  END IF;

  SELECT organization_id, scope_type, is_mutable
    INTO v_def_org, v_def_scope, v_def_mutable
    FROM public.lookup_definitions WHERE id = v_lookup_definition_id;
  IF v_def_scope IS NULL THEN
    RAISE EXCEPTION 'lookup_value_create_v1 lookup_definition % not found', v_lookup_definition_id
      USING ERRCODE = '23503';
  END IF;
  IF v_def_mutable IS FALSE AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'lookup_value_create_v1 lookup_definition % is_mutable=false; only platform users can extend',
                    v_lookup_definition_id
      USING ERRCODE = '42501';
  END IF;
  IF v_def_scope = 'tenant'
     AND v_def_org IS NOT NULL
     AND v_org_id IS NOT NULL
     AND v_def_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'lookup_value_create_v1 lookup_definition % outside tenant scope',
                    v_lookup_definition_id
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.lookup_values (
    lookup_definition_id, value, label, description, sort_order, status, metadata,
    organization_id, created_by
  ) VALUES (
    v_lookup_definition_id, v_value, v_label, v_description, v_sort_order, v_status, v_metadata,
    COALESCE(v_def_org, v_org_id), v_user_id
  )
  RETURNING id INTO v_resource_id;

  -- Append revision row (action=create, revision=1)
  INSERT INTO public.lookup_value_revisions (
    lookup_value_id, organization_id, revision, action,
    after_value, changed_by, correlation_id, decision_log_id
  ) VALUES (
    v_resource_id, COALESCE(v_def_org, v_org_id), 1, 'create',
    p_args, v_user_id, v_correlation_id, v_decision_id
  );

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_def_org, v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'lookup_values.create', 'lookup_value', v_resource_id,
    'lookup_value_create_v1', 'created',
    jsonb_strip_nulls(jsonb_build_object('lookup_definition_id', v_lookup_definition_id, 'value', v_value, 'status', v_status)),
    'lookup_value_create_v1', v_correlation_id::uuid
  );

  IF v_def_org IS NOT NULL OR v_org_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_def_org, v_org_id), 'lookup_value.created', 'lookup_value', v_resource_id,
      jsonb_build_object('value', v_value, 'status', v_status),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'lookup_value_id', v_resource_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.lookup_value_create_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.lookup_value_create_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.lookup_value_create_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.lookup_value_create_v1(jsonb)
  IS 'Canonical write RPC: insert lookup_values row + revision + decision_log + domain_event. Capability: lookups.write.';

SELECT pg_advisory_unlock(hashtext('202604280208_lookup_value_create_v1'));
COMMIT;
