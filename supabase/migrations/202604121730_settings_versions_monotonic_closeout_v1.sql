BEGIN;

SELECT pg_advisory_lock(hashtext('202604121730_settings_versions_monotonic_closeout_v1'));

CREATE OR REPLACE FUNCTION workflow_handlers.execute_settings_apply_v1(
    p_step workflow_run_steps,
    p_run workflow_runs,
    p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
AS $$
DECLARE
    v_ctx JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_task_id UUID := NULLIF(v_ctx->>'manual_review_task_id', '')::UUID;

    v_task public.manual_review_tasks%ROWTYPE;
    v_settings_version_id UUID;
    v_sv public.settings_versions%ROWTYPE;

    v_org UUID;
    v_now TIMESTAMPTZ := now();
    v_resp workflow_handler_response;
BEGIN
    IF v_task_id IS NULL THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id missing from workflow context (workflow_run_id=%)', p_run.id;
    END IF;

    SELECT * INTO v_task FROM public.manual_review_tasks mrt WHERE mrt.id = v_task_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'settings_apply: manual_review_task_id % not found', v_task_id;
    END IF;

    IF v_task.status <> 'resolved' OR v_task.resolution_outcome IS DISTINCT FROM 'approved' THEN
        v_resp.status := 'failed';
        v_resp.last_error := 'settings_apply: approval missing or rejected';
        v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
          'manual_review_task_id', v_task_id,
          'resolution_outcome', v_task.resolution_outcome,
          'resolution_notes', v_task.resolution_notes
        ));
        RETURN v_resp;
    END IF;

    IF v_task.resource_type = 'settings_version' AND v_task.resource_id IS NOT NULL THEN
      v_settings_version_id := v_task.resource_id;
    ELSE
      v_settings_version_id := NULLIF(v_ctx->>'resource_id', '')::UUID;
    END IF;

    IF v_settings_version_id IS NULL THEN
      RAISE EXCEPTION 'settings_apply: settings_version_id missing (manual_review_task_id=%)', v_task_id;
    END IF;

    SELECT *
      INTO v_sv
      FROM public.settings_versions sv
     WHERE sv.id = v_settings_version_id
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'settings_apply: settings_versions row not found for id=%', v_settings_version_id;
    END IF;

    v_org := COALESCE(v_task.organization_id, NULLIF(v_ctx->'payload'->>'organization_id', '')::UUID, public.current_user_org_id());
    IF v_org IS NULL THEN
      RAISE EXCEPTION 'settings_apply: organization_id missing for decision log (settings_version_id=%)', v_settings_version_id;
    END IF;

    -- Keep append-only history monotonic even when the previous row was future-dated.
    UPDATE public.settings_versions
       SET effective_until = GREATEST(
             v_now,
             effective_from + INTERVAL '1 microsecond'
           )
     WHERE category = v_sv.category
       AND scope_type = v_sv.scope_type
       AND scope_hash = v_sv.scope_hash
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND id <> v_settings_version_id;

    UPDATE public.settings_versions
       SET approved_at = COALESCE(approved_at, v_task.resolved_at, v_now),
           approved_by = COALESCE(approved_by, v_task.resolved_by),
           effective_from = CASE WHEN approved_at IS NULL THEN v_now ELSE effective_from END
     WHERE id = v_settings_version_id
       AND scope_hash = v_sv.scope_hash;

    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      gen_random_uuid(),
      v_sv.category,
      v_sv.scope_type,
      v_sv.scope_id,
      v_sv.scope_hash,
      v_settings_version_id,
      v_sv.value,
      v_now
    )
    ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET scope_id = EXCLUDED.scope_id,
        settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;

    PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings',
        p_resource_type := 'settings_version',
        p_resource_id := v_settings_version_id,
        p_decision_point := 'apply',
        p_decision_outcome := 'applied',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'category', v_sv.category,
          'scope_type', v_sv.scope_type,
          'scope_id', v_sv.scope_id,
          'manual_review_task_id', v_task_id,
          'approved_by', v_task.resolved_by
        )),
        p_decision_reason := NULL
    );

    v_resp.status := 'completed';
    v_resp.operation_result := jsonb_strip_nulls(jsonb_build_object(
      'settings_version_id', v_settings_version_id,
      'category', v_sv.category,
      'scope_type', v_sv.scope_type,
      'scope_id', v_sv.scope_id
    ));
    v_resp.context_patch := jsonb_strip_nulls(jsonb_build_object(
      'settings_applied', jsonb_build_object(
        'settings_version_id', v_settings_version_id,
        'category', v_sv.category,
        'scope_type', v_sv.scope_type,
        'scope_id', v_sv.scope_id,
        'applied_at', v_now
      )
    ));
    RETURN v_resp;
END;
$$;

CREATE OR REPLACE FUNCTION public.upsert_settings_value_v1(
  p_category TEXT,
  p_scope_type TEXT,
  p_scope_id UUID,
  p_value JSONB,
  p_schema_version INT,
  p_change_reason TEXT
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  settings_version_number INT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT := NULLIF(TRIM(p_category), '');
  v_scope_type TEXT;
  v_scope_id UUID := p_scope_id;
  v_value JSONB;
  v_entity_table REGCLASS;
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_allowed_scopes JSONB;
  v_existing settings%ROWTYPE;
  v_next_version INT;
  v_sv_id UUID := gen_random_uuid();
BEGIN
  IF v_category IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires category';
  END IF;
  IF NULLIF(TRIM(p_scope_type), '') IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires scope_type';
  END IF;
  IF p_value IS NULL THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires value';
  END IF;
  IF p_schema_version IS NULL OR p_schema_version < 1 THEN
    RAISE EXCEPTION 'upsert_settings_value_v1 requires schema_version >= 1';
  END IF;

  v_scope_type := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_value := public.normalize_settings_value_v1(v_category, p_value);

  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF v_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'upsert_settings_value_v1 scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  SELECT scr.allowed_scopes
    INTO v_allowed_scopes
    FROM public.settings_category_registry scr
   WHERE scr.category = v_category
   LIMIT 1;

  IF v_allowed_scopes IS NOT NULL AND jsonb_typeof(v_allowed_scopes) = 'array' THEN
    IF NOT (v_allowed_scopes ? v_scope_type) THEN
      RAISE EXCEPTION 'Scope "%" is not allowed for category "%"', v_scope_type, v_category
        USING ERRCODE = '23514';
    END IF;
  END IF;

  -- Keep append-only history monotonic even when the previous row was future-dated.
  UPDATE public.settings_versions
     SET effective_until = GREATEST(
           clock_timestamp(),
           effective_from + INTERVAL '1 microsecond'
         )
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id)
     AND effective_until IS NULL
     AND approved_at IS NOT NULL;

  SELECT COALESCE(MAX(version) + 1, 1)
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = v_category
     AND scope_type = v_scope_type
     AND (scope_id IS NOT DISTINCT FROM v_scope_id);

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    v_category,
    v_scope_type,
    v_scope_id,
    v_next_version,
    v_value,
    p_schema_version,
    COALESCE(NULLIF(TRIM(p_change_reason), ''), 'upsert via upsert_settings_value_v1'),
    clock_timestamp(),
    clock_timestamp()
  );

  SELECT *
    INTO v_existing
    FROM public.settings s
   WHERE s.category = v_category
     AND s.scope_type = v_scope_type
     AND (s.scope_id IS NOT DISTINCT FROM v_scope_id)
   LIMIT 1;

  IF v_existing.id IS NULL THEN
    settings_id := gen_random_uuid();
    INSERT INTO public.settings (
      id,
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    ) VALUES (
      settings_id,
      v_category,
      v_scope_type,
      v_scope_id,
      v_sv_id,
      v_value,
      clock_timestamp()
    );
  ELSE
    settings_id := v_existing.id;
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_value,
           last_updated = clock_timestamp()
     WHERE id = v_existing.id;
  END IF;

  settings_version_id := v_sv_id;
  settings_version_number := v_next_version;
  RETURN NEXT;
END;
$function$;

REVOKE ALL ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.upsert_settings_value_v1(TEXT, TEXT, UUID, JSONB, INT, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202604121730_settings_versions_monotonic_closeout_v1'));
COMMIT;
