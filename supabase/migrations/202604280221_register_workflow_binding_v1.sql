-- Spec-Issue: Phase B6 - Workflow RPC contract: register_workflow_binding_v1
-- Step: B6-RPC-21
-- Capability: workflows.write
--
-- Behavior: registers a (binding_key, stage_key) -> workflow_template_id
-- mapping at the requested scope. Writes to public.workflow_binding_policy
-- via settings_versions (canonical configuration ladder), records audit row in
-- public.workflow_binding_registrations (foundation migration).

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280221_register_workflow_binding_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.register_workflow_binding_v1(p_args jsonb)
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
  v_binding_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'binding_key', '')), ''));
  v_stage_key TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'stage_key', '')), ''));
  v_workflow_template_id UUID := NULLIF(p_args->>'workflow_template_id', '')::uuid;
  v_scope_type TEXT := lower(COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'tenant'));
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_inline_steps INTEGER := NULLIF(p_args->>'inline_progress_steps', '')::int;
  v_notes TEXT := NULLIF(btrim(COALESCE(p_args->>'notes', '')), '');
  v_current JSONB;
  v_next JSONB;
  v_next_version INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_binding_key IS NULL OR v_stage_key IS NULL THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 requires binding_key and stage_key'
      USING ERRCODE = '23502';
  END IF;
  IF v_scope_type NOT IN ('global', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;
  IF v_scope_type = 'global' AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 scope=global requires platform user'
      USING ERRCODE = '42501';
  END IF;
  IF v_scope_type = 'tenant' AND v_scope_id IS NULL THEN
    v_scope_id := v_org_id;
  END IF;
  IF v_scope_type = 'tenant'
     AND v_org_id IS NOT NULL
     AND v_scope_id <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'register_workflow_binding_v1 scope_id outside tenant scope'
      USING ERRCODE = '42501';
  END IF;

  -- Read existing settings row (if any).
  SELECT value INTO v_current
    FROM public.settings_versions
   WHERE category = 'workflow_binding_policy'
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id
   ORDER BY version DESC
   LIMIT 1;

  v_current := COALESCE(v_current, jsonb_build_object('version', 1, 'bindings', '{}'::jsonb));

  -- Set bindings.<binding_key>.stages.<stage_key> = { enabled, workflow_template_id, ... }
  v_next := jsonb_set(
    v_current,
    ARRAY['bindings', v_binding_key, 'stages', v_stage_key],
    jsonb_strip_nulls(jsonb_build_object(
      'enabled', v_enabled,
      'workflow_template_id', COALESCE(v_workflow_template_id::text, NULL),
      'inline_progress_steps', v_inline_steps,
      'notes', v_notes
    )),
    TRUE
  );

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'workflow_binding_policy'
     AND scope_type = v_scope_type
     AND scope_id IS NOT DISTINCT FROM v_scope_id;

  INSERT INTO public.settings_versions (
    category, scope_type, scope_id, version, value, schema_version,
    change_reason, approved_at, effective_from
  ) VALUES (
    'workflow_binding_policy', v_scope_type, v_scope_id, v_next_version, v_next, 1,
    COALESCE('register_workflow_binding_v1: ' || v_binding_key || '/' || v_stage_key, 'register_workflow_binding_v1'),
    now(), now()
  );

  -- Refresh settings cache row for this scope.
  INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  SELECT sv.category, sv.scope_type, sv.scope_id, sv.id, sv.value, now()
    FROM public.settings_versions sv
   WHERE sv.category = 'workflow_binding_policy'
     AND sv.scope_type = v_scope_type
     AND sv.scope_id IS NOT DISTINCT FROM v_scope_id
     AND sv.version = v_next_version
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

  -- Audit ledger row.
  INSERT INTO public.workflow_binding_registrations (
    organization_id, binding_key, stage_key, workflow_template_id,
    scope_type, scope_id, binding_payload, changed_by,
    correlation_id, decision_log_id
  ) VALUES (
    v_org_id, v_binding_key, v_stage_key, v_workflow_template_id,
    v_scope_type, v_scope_id, p_args, v_user_id,
    v_correlation_id, v_decision_id
  )
  RETURNING id INTO v_resource_id;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_org_id, '00000000-0000-0000-0000-000000000000'::uuid),
    'workflows.binding_register', 'workflow_binding', v_resource_id,
    'register_workflow_binding_v1', 'registered',
    jsonb_strip_nulls(jsonb_build_object(
      'binding_key', v_binding_key, 'stage_key', v_stage_key,
      'scope_type', v_scope_type, 'scope_id', v_scope_id
    )),
    'register_workflow_binding_v1', v_correlation_id::uuid
  );

  IF v_org_id IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_org_id, 'workflow_binding.registered', 'workflow_binding', v_resource_id,
      jsonb_build_object('binding_key', v_binding_key, 'stage_key', v_stage_key, 'scope_type', v_scope_type),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'workflow_binding_registration_id', v_resource_id,
    'binding_key', v_binding_key,
    'stage_key', v_stage_key,
    'settings_version', v_next_version,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.register_workflow_binding_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.register_workflow_binding_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.register_workflow_binding_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.register_workflow_binding_v1(jsonb)
  IS 'Canonical write RPC: persist binding_key/stage_key -> workflow_template_id mapping in workflow_binding_policy + append registration audit. Capability: workflows.write.';

SELECT pg_advisory_unlock(hashtext('202604280221_register_workflow_binding_v1'));
COMMIT;
