BEGIN;
SET LOCAL lock_timeout = '10s';

CREATE OR REPLACE FUNCTION public.create_feature_flag_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_key TEXT := NULLIF(btrim(COALESCE(p_args->>'flag_key', p_args->>'name', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_args->>'initial_status', p_args->>'status', '')), ''), 'off');
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'global');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_enabled BOOLEAN := FALSE;
  v_rollout INTEGER := 0;
  v_conditions JSONB := '{}'::jsonb;
  v_flag_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires flag_key or name'
      USING ERRCODE = '23502';
  END IF;

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  ELSIF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires scope_id for scope_type=%', v_scope_type
      USING ERRCODE = '23502';
  END IF;

  IF v_status = 'on' THEN
    v_enabled := TRUE;
    v_rollout := 100;
  ELSIF v_status = 'percentage' THEN
    v_enabled := TRUE;
    v_rollout := LEAST(100, GREATEST(0, COALESCE(NULLIF(p_args->>'rollout_percentage', '')::int, 1)));
  ELSE
    v_enabled := FALSE;
    v_rollout := 0;
  END IF;

  v_conditions := jsonb_strip_nulls(jsonb_build_object(
    'label', NULLIF(btrim(COALESCE(p_args->>'flag_label', p_args->>'label', '')), ''),
    'owners', COALESCE(p_args->'owners', '[]'::jsonb),
    'scopes', COALESCE(p_args#>'{targeting,scopes}', '[]'::jsonb),
    'last_updated_by_user_id', v_user_id
  ));

  INSERT INTO public.feature_flags (
    name,
    description,
    scope_type,
    scope_id,
    enabled,
    rollout_percentage,
    conditions
  ) VALUES (
    v_key,
    v_description,
    v_scope_type,
    v_scope_id,
    v_enabled,
    v_rollout,
    v_conditions
  )
  RETURNING id INTO v_flag_id;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag_id,
    'name', v_key,
    'enabled', v_enabled,
    'rollout_percentage', v_rollout,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.update_feature_flag_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', p_args->>'flag_key', '')), '');
  v_flag public.feature_flags%ROWTYPE;
  v_conditions JSONB;
  v_scope_type TEXT := NULLIF(btrim(p_args->>'scope_type'), '');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  v_conditions := COALESCE(v_flag.conditions, '{}'::jsonb);

  IF p_args ? 'conditions' THEN
    v_conditions := v_conditions || COALESCE(p_args->'conditions', '{}'::jsonb);
  END IF;
  IF p_args ? 'targeting' THEN
    v_conditions := jsonb_set(
      v_conditions,
      '{scopes}',
      COALESCE(p_args#>'{targeting,scopes}', '[]'::jsonb),
      TRUE
    );
  END IF;
  IF p_args ? 'owners' THEN
    v_conditions := jsonb_set(v_conditions, '{owners}', COALESCE(p_args->'owners', '[]'::jsonb), TRUE);
  END IF;

  v_conditions := jsonb_set(v_conditions, '{last_updated_by_user_id}', to_jsonb(v_user_id::text), TRUE);

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  END IF;

  UPDATE public.feature_flags
     SET description = CASE WHEN p_args ? 'description' THEN NULLIF(btrim(p_args->>'description'), '') ELSE description END,
         scope_type = COALESCE(v_scope_type, scope_type),
         scope_id = CASE WHEN v_scope_type IS NULL THEN scope_id ELSE v_scope_id END,
         conditions = v_conditions,
         updated_at = now()
   WHERE id = v_flag.id;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'name', v_flag.name,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.toggle_feature_flag_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(p_args->>'name'), '');
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_target_enabled BOOLEAN := NULLIF(p_args->>'enabled', '')::boolean;
  v_flag public.feature_flags%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'toggle_feature_flag_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'toggle_feature_flag_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'toggle_feature_flag_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  -- If target enabled supplied, set to that; otherwise flip
  IF v_target_enabled IS NULL THEN
    v_target_enabled := NOT v_flag.enabled;
  END IF;

  IF v_flag.enabled <> v_target_enabled THEN
    UPDATE public.feature_flags
       SET enabled = v_target_enabled,
           updated_at = now()
     WHERE id = v_flag.id;

    INSERT INTO public.feature_flag_kill_events (
      feature_flag_id, organization_id, event_type, reason,
      prior_enabled, prior_rollout_percentage,
      acted_by, correlation_id, decision_log_id, settings_resolution_id, payload
    ) VALUES (
      v_flag.id, v_org_id, 'toggled',
      NULLIF(btrim(p_args->>'reason'), ''),
      v_flag.enabled, v_flag.rollout_percentage,
      v_user_id, v_correlation_id, v_decision_id, NULL,
      jsonb_build_object('from', v_flag.enabled, 'to', v_target_enabled)
    );

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_org_id, v_flag.scope_id),
      'feature_flags.toggle', 'feature_flag', v_flag.id,
      'toggle_feature_flag_v1',
      CASE WHEN v_target_enabled THEN 'enabled' ELSE 'disabled' END,
      'toggle_feature_flag_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_org_id, v_flag.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      CASE WHEN v_target_enabled THEN 'feature_flag.enabled' ELSE 'feature_flag.disabled' END,
      'feature_flag', v_flag.id,
      jsonb_build_object('name', v_flag.name, 'enabled', v_target_enabled),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'name', v_flag.name,
    'enabled', v_target_enabled,
    'idempotent', v_flag.enabled = v_target_enabled,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.engage_kill_switch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(p_args->>'name'), '');
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_reason TEXT := NULLIF(btrim(p_args->>'reason'), '');
  v_flag public.feature_flags%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires reason for audit trail'
      USING ERRCODE = '23502';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'engage_kill_switch_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  -- Always append kill_events for engagement intent (audit even on idempotent)
  INSERT INTO public.feature_flag_kill_events (
    feature_flag_id, organization_id, event_type, reason,
    prior_enabled, prior_rollout_percentage,
    acted_by, correlation_id, decision_log_id, settings_resolution_id, payload
  ) VALUES (
    v_flag.id, v_org_id, 'engaged', v_reason,
    v_flag.enabled, v_flag.rollout_percentage,
    v_user_id, v_correlation_id, v_decision_id, NULL,
    jsonb_build_object('idempotent', NOT v_flag.enabled AND v_flag.rollout_percentage = 0)
  );

  IF v_flag.enabled OR v_flag.rollout_percentage > 0 THEN
    UPDATE public.feature_flags
       SET enabled = FALSE,
           rollout_percentage = 0,
           updated_at = now()
     WHERE id = v_flag.id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_reason, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_org_id, v_flag.scope_id),
      'feature_flags.kill_switch', 'feature_flag', v_flag.id,
      'engage_kill_switch_v1', 'engaged', v_reason,
      'engage_kill_switch_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_org_id, v_flag.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      'feature_flag.kill_switch_engaged', 'feature_flag', v_flag.id,
      jsonb_build_object('reason', v_reason, 'name', v_flag.name),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'enabled', false,
    'rollout_percentage', 0,
    'idempotent', NOT v_flag.enabled AND v_flag.rollout_percentage = 0,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.release_kill_switch_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(p_args->>'name'), '');
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_reason TEXT := NULLIF(btrim(p_args->>'reason'), '');
  v_target_enabled BOOLEAN := NULLIF(p_args->>'target_enabled', '')::boolean;
  v_target_rollout INT := NULLIF(p_args->>'target_rollout', '')::int;
  v_flag public.feature_flags%ROWTYPE;
  v_engage RECORD;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'release_kill_switch_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'release_kill_switch_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'release_kill_switch_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  -- If no explicit target, derive from latest 'engaged' kill_event prior_* state.
  IF v_target_enabled IS NULL OR v_target_rollout IS NULL THEN
    SELECT prior_enabled, prior_rollout_percentage
      INTO v_engage
      FROM public.feature_flag_kill_events
     WHERE feature_flag_id = v_flag.id
       AND event_type = 'engaged'
     ORDER BY created_at DESC
     LIMIT 1;

    v_target_enabled := COALESCE(v_target_enabled, v_engage.prior_enabled, FALSE);
    v_target_rollout := COALESCE(v_target_rollout, v_engage.prior_rollout_percentage, 0);
  END IF;

  IF v_target_rollout < 0 OR v_target_rollout > 100 THEN
    RAISE EXCEPTION 'release_kill_switch_v1 target_rollout must be 0..100'
      USING ERRCODE = '22023';
  END IF;

  -- Append audit even if no-op
  INSERT INTO public.feature_flag_kill_events (
    feature_flag_id, organization_id, event_type, reason,
    prior_enabled, prior_rollout_percentage,
    acted_by, correlation_id, decision_log_id, settings_resolution_id, payload
  ) VALUES (
    v_flag.id, v_org_id, 'released', v_reason,
    v_flag.enabled, v_flag.rollout_percentage,
    v_user_id, v_correlation_id, v_decision_id, NULL,
    jsonb_build_object('restored_enabled', v_target_enabled, 'restored_rollout', v_target_rollout)
  );

  IF v_flag.enabled <> v_target_enabled OR v_flag.rollout_percentage <> v_target_rollout THEN
    UPDATE public.feature_flags
       SET enabled = v_target_enabled,
           rollout_percentage = v_target_rollout,
           updated_at = now()
     WHERE id = v_flag.id;

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, decision_reason, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_org_id, v_flag.scope_id),
      'feature_flags.kill_switch', 'feature_flag', v_flag.id,
      'release_kill_switch_v1', 'released', v_reason,
      'release_kill_switch_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_org_id, v_flag.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      'feature_flag.kill_switch_released', 'feature_flag', v_flag.id,
      jsonb_build_object('name', v_flag.name, 'enabled', v_target_enabled, 'rollout', v_target_rollout),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'enabled', v_target_enabled,
    'rollout_percentage', v_target_rollout,
    'idempotent', v_flag.enabled = v_target_enabled AND v_flag.rollout_percentage = v_target_rollout,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.set_rollout_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(p_args->>'name'), '');
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_target_rollout INT := NULLIF(p_args->>'rollout_percentage', '')::int;
  v_flag public.feature_flags%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'set_rollout_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF v_target_rollout IS NULL THEN
    RAISE EXCEPTION 'set_rollout_v1 requires rollout_percentage'
      USING ERRCODE = '23502';
  END IF;

  IF v_target_rollout < 0 OR v_target_rollout > 100 THEN
    RAISE EXCEPTION 'set_rollout_v1 rollout_percentage must be 0..100 (got %)', v_target_rollout
      USING ERRCODE = '22023';
  END IF;

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'set_rollout_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'set_rollout_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  IF v_flag.rollout_percentage <> v_target_rollout THEN
    UPDATE public.feature_flags
       SET rollout_percentage = v_target_rollout,
           updated_at = now()
     WHERE id = v_flag.id;

    INSERT INTO public.feature_flag_kill_events (
      feature_flag_id, organization_id, event_type,
      prior_enabled, prior_rollout_percentage,
      acted_by, correlation_id, decision_log_id, settings_resolution_id, payload
    ) VALUES (
      v_flag.id, v_org_id, 'rollout_changed',
      v_flag.enabled, v_flag.rollout_percentage,
      v_user_id, v_correlation_id, v_decision_id, NULL,
      jsonb_build_object('from', v_flag.rollout_percentage, 'to', v_target_rollout)
    );

    INSERT INTO public.decision_log (
      id, organization_id, decision_category, resource_type, resource_id,
      decision_point, decision_outcome, performed_by_system, correlation_id
    ) VALUES (
      v_decision_id, COALESCE(v_org_id, v_flag.scope_id),
      'feature_flags.rollout', 'feature_flag', v_flag.id,
      'set_rollout_v1', 'rollout_changed',
      'set_rollout_v1', v_correlation_id
    );

    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      COALESCE(v_org_id, v_flag.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
      'feature_flag.rollout_changed', 'feature_flag', v_flag.id,
      jsonb_build_object('name', v_flag.name, 'rollout', v_target_rollout),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'rollout_percentage', v_target_rollout,
    'idempotent', v_flag.rollout_percentage = v_target_rollout,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.bulk_toggle_feature_flags_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id UUID := gen_random_uuid();
  v_flags JSONB := COALESCE(p_args->'flags', '[]'::jsonb);
  v_default_enabled BOOLEAN := NULLIF(p_args->>'enabled', '')::boolean;
  v_results JSONB := '[]'::jsonb;
  v_idx INT;
  v_entry JSONB;
  v_flag_args JSONB;
  v_result JSONB;
  v_success_count INT := 0;
  v_error_count INT := 0;
  v_err_text TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'bulk_toggle_feature_flags_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  IF public.is_platform_user() IS TRUE THEN
    PERFORM public.assert_capability_v1('feature_flags.write');
  ELSIF NOT EXISTS (
    -- The scope resolver requires an organization. Use the same global policy
    -- for an active platform profile that has no organization.
    SELECT 1
    FROM public.users u
    CROSS JOIN LATERAL public.access_eval_capability_v1(
      public.resolve_settings_merged('access_control_policy', 'global', NULL),
      'feature_flags.write', 'global', NULL, u.id, u.user_type
    ) AS capability
    WHERE u.id = v_user_id
      AND u.organization_id IS NULL
      AND u.access_scope_type = 'platform'
      AND lower(u.status) = 'active'
      AND capability.allowed
      AND EXISTS (
        SELECT 1
        FROM public.resolve_settings_row('access_control_policy', 'global', NULL) policy
        WHERE policy.settings_id IS NOT NULL
      )
  ) THEN
    RAISE EXCEPTION 'Capability denied: feature_flags.write'
      USING ERRCODE = '42501';
  END IF;

  IF jsonb_typeof(v_flags) <> 'array' OR jsonb_array_length(v_flags) = 0 THEN
    RAISE EXCEPTION 'bulk_toggle_feature_flags_v1 requires flags array'
      USING ERRCODE = '23502';
  END IF;

  FOR v_idx IN 0 .. jsonb_array_length(v_flags) - 1 LOOP
    v_entry := v_flags->v_idx;

    v_flag_args := jsonb_build_object(
      'feature_flag_id', NULLIF(v_entry->>'feature_flag_id', ''),
      'name', NULLIF(v_entry->>'name', ''),
      'enabled', COALESCE(NULLIF(v_entry->>'enabled', '')::boolean, v_default_enabled),
      'reason', NULLIF(v_entry->>'reason', '')
    );

    BEGIN
      v_result := public.toggle_feature_flag_v1(v_flag_args);
      v_results := v_results || jsonb_build_array(jsonb_build_object(
        'index', v_idx,
        'ok', true,
        'feature_flag_id', v_result->'feature_flag_id',
        'enabled', v_result->'enabled',
        'idempotent', v_result->'idempotent',
        'correlation_id', v_result->'correlation_id'
      ));
      v_success_count := v_success_count + 1;
    EXCEPTION
      WHEN OTHERS THEN
        v_err_text := SQLERRM;
        v_results := v_results || jsonb_build_array(jsonb_build_object(
          'index', v_idx,
          'ok', false,
          'feature_flag_id', NULLIF(v_entry->>'feature_flag_id', ''),
          'name', NULLIF(v_entry->>'name', ''),
          'error', v_err_text,
          'sqlstate', SQLSTATE
        ));
        v_error_count := v_error_count + 1;
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'ok', v_error_count = 0,
    'success_count', v_success_count,
    'error_count', v_error_count,
    'results', v_results,
    'correlation_id', v_correlation_id
  );
END;
$$;

REVOKE EXECUTE ON FUNCTION
  public.create_feature_flag_v1(jsonb),
  public.update_feature_flag_v1(jsonb),
  public.toggle_feature_flag_v1(jsonb),
  public.engage_kill_switch_v1(jsonb),
  public.release_kill_switch_v1(jsonb),
  public.set_rollout_v1(jsonb),
  public.bulk_toggle_feature_flags_v1(jsonb)
FROM PUBLIC, anon;

COMMIT;
