-- Console V2 workflow run trigger lifecycle RPCs.
-- Adds backend-backed update and delete actions for the visible trigger composer.

BEGIN;
SELECT pg_advisory_lock(hashtext('202606011430_workflow_run_trigger_lifecycle_rpc_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

ALTER TABLE public.workflow_run_triggers
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID REFERENCES public.users(id),
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

DROP INDEX IF EXISTS public.idx_workflow_run_triggers_unique_binding;
CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_run_triggers_unique_binding
  ON public.workflow_run_triggers(scope_type, scope_id, source_workflow_template_id, target_workflow_template_id, source_statuses)
  WHERE deleted_at IS NULL;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[],
  p_context_patch JSONB,
  p_enabled BOOLEAN,
  p_notes TEXT,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_scope_type TEXT := public.current_user_scope_type();
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_current_org_id UUID := public.current_user_org_id();
  v_scope_type TEXT := v_actor_scope_type;
  v_scope_id UUID := v_actor_scope_id;
  v_trigger_id UUID;
BEGIN
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_actor_scope_type, v_actor_scope_id);

  IF p_scope_id IS NOT NULL
     AND v_actor_scope_type NOT IN ('platform', 'tenant', 'organization') THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
      USING ERRCODE = '42501';
  END IF;

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'tenant';
    v_scope_id := COALESCE(p_scope_id, v_current_org_id);
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  IF v_scope_type = 'tenant' THEN
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
    IF p_scope_id IS NOT NULL AND p_scope_id <> v_scope_id THEN
      RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_actor_scope_type = 'platform'
     AND p_scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_scope_id) THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 active tenant scope_id does not exist'
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_type NOT IN ('tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 invalid trigger scope_type %',
      COALESCE(v_scope_type, 'null')
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 trigger scope_id is required'
      USING ERRCODE = '23502';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.id = p_source_workflow_template_id
       AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
  ) THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 source workflow template is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
     WHERE wt.id = p_target_workflow_template_id
       AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
  ) THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 target workflow template is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.workflow_run_triggers (
    scope_type,
    scope_id,
    source_workflow_template_id,
    target_workflow_template_id,
    source_statuses,
    context_patch,
    enabled,
    created_by,
    notes
  )
  VALUES (
    v_scope_type,
    v_scope_id,
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    COALESCE(p_source_statuses, ARRAY['succeeded']::TEXT[]),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING id INTO v_trigger_id;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_run_trigger_id', v_trigger_id::text
  );
END;
$$;

COMMENT ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'Creates row-driven workflow run triggers through Console V2. Capability: workflows.write. Source and target templates must be visible to the caller scope.';

REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_update_workflow_run_trigger_v1(
  p_workflow_run_trigger_id UUID,
  p_source_workflow_template_id UUID DEFAULT NULL,
  p_target_workflow_template_id UUID DEFAULT NULL,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT NULL,
  p_enabled BOOLEAN DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_scope_type TEXT := public.current_user_scope_type();
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_current_org_id UUID := public.current_user_org_id();
  v_expected_scope_type TEXT := v_actor_scope_type;
  v_expected_scope_id UUID := v_actor_scope_id;
  v_existing public.workflow_run_triggers%ROWTYPE;
  v_updated public.workflow_run_triggers%ROWTYPE;
BEGIN
  IF p_workflow_run_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 requires workflow_run_trigger_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_actor_scope_type, v_actor_scope_id);

  IF p_scope_id IS NOT NULL
     AND v_actor_scope_type NOT IN ('platform', 'tenant', 'organization') THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
      USING ERRCODE = '42501';
  END IF;

  IF v_expected_scope_type = 'platform' THEN
    v_expected_scope_type := 'tenant';
    v_expected_scope_id := COALESCE(p_scope_id, v_current_org_id);
  ELSIF v_expected_scope_type = 'organization' THEN
    v_expected_scope_type := 'tenant';
  END IF;

  IF v_expected_scope_type = 'tenant' THEN
    v_expected_scope_id := COALESCE(v_expected_scope_id, v_current_org_id);
    IF p_scope_id IS NOT NULL AND p_scope_id <> v_expected_scope_id THEN
      RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_actor_scope_type = 'platform'
     AND p_scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 active tenant scope_id does not exist'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.workflow_run_triggers
   WHERE id = p_workflow_run_trigger_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 workflow run trigger not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF v_existing.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 cannot update a deleted workflow run trigger'
      USING ERRCODE = '55000';
  END IF;

  IF NOT public.workflow_template_scope_allowed(v_existing.scope_type, v_existing.scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 workflow run trigger is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_expected_scope_type IN ('tenant', 'client', 'sender')
     AND (v_existing.scope_type <> v_expected_scope_type OR v_existing.scope_id <> v_expected_scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 workflow run trigger is outside active scope'
      USING ERRCODE = '42501';
  END IF;

  IF p_source_workflow_template_id IS NOT NULL
     AND p_source_workflow_template_id <> v_existing.source_workflow_template_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.workflow_templates wt
        WHERE wt.id = p_source_workflow_template_id
          AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
     ) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 source workflow template is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF p_target_workflow_template_id IS NOT NULL
     AND p_target_workflow_template_id <> v_existing.target_workflow_template_id
     AND NOT EXISTS (
       SELECT 1
         FROM public.workflow_templates wt
        WHERE wt.id = p_target_workflow_template_id
          AND public.workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
     ) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 target workflow template is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF COALESCE(p_source_workflow_template_id, v_existing.source_workflow_template_id)
     = COALESCE(p_target_workflow_template_id, v_existing.target_workflow_template_id) THEN
    RAISE EXCEPTION 'workflow_run_triggers: source and target templates must differ';
  END IF;

  UPDATE public.workflow_run_triggers
     SET source_workflow_template_id = COALESCE(p_source_workflow_template_id, source_workflow_template_id),
         target_workflow_template_id = COALESCE(p_target_workflow_template_id, target_workflow_template_id),
         source_statuses = COALESCE(p_source_statuses, source_statuses),
         context_patch = COALESCE(p_context_patch, context_patch),
         enabled = COALESCE(p_enabled, enabled),
         notes = CASE
           WHEN p_notes IS NULL THEN notes
           ELSE NULLIF(btrim(p_notes), '')
         END
   WHERE id = p_workflow_run_trigger_id
   RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'status', 'updated',
    'workflow_run_trigger_id', v_updated.id::text,
    'source_workflow_template_id', v_updated.source_workflow_template_id::text,
    'target_workflow_template_id', v_updated.target_workflow_template_id::text,
    'source_statuses', to_jsonb(v_updated.source_statuses),
    'context_patch', v_updated.context_patch,
    'scope_type', v_updated.scope_type,
    'scope_id', v_updated.scope_id::text,
    'enabled', v_updated.enabled,
    'notes', v_updated.notes,
    'updated_at', v_updated.updated_at
  );
END;
$$;

COMMENT ON FUNCTION public.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'Updates row-driven workflow run trigger configuration through Console V2. Capability: workflows.write. The before-write trigger canonicalizes statuses and scope lineage.';

REVOKE ALL ON FUNCTION public.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_update_workflow_run_trigger_v1(
  p_workflow_run_trigger_id UUID,
  p_source_workflow_template_id UUID DEFAULT NULL,
  p_target_workflow_template_id UUID DEFAULT NULL,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT NULL,
  p_enabled BOOLEAN DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_update_workflow_run_trigger_v1(
    p_workflow_run_trigger_id,
    p_source_workflow_template_id,
    p_target_workflow_template_id,
    p_source_statuses,
    p_context_patch,
    p_enabled,
    p_notes,
    p_scope_id
  );
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'API-schema wrapper for Console V2 workflow run trigger update lifecycle actions.';

CREATE OR REPLACE FUNCTION public.ui_delete_workflow_run_trigger_v1(
  p_workflow_run_trigger_id UUID,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_actor_scope_type TEXT := public.current_user_scope_type();
  v_actor_scope_id UUID := public.current_user_scope_id();
  v_current_org_id UUID := public.current_user_org_id();
  v_expected_scope_type TEXT := v_actor_scope_type;
  v_expected_scope_id UUID := v_actor_scope_id;
  v_existing public.workflow_run_triggers%ROWTYPE;
  v_updated public.workflow_run_triggers%ROWTYPE;
  v_fire_count BIGINT := 0;
BEGIN
  IF p_workflow_run_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 requires workflow_run_trigger_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write', v_actor_scope_type, v_actor_scope_id);

  IF p_scope_id IS NOT NULL
     AND v_actor_scope_type NOT IN ('platform', 'tenant', 'organization') THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
      USING ERRCODE = '42501';
  END IF;

  IF v_expected_scope_type = 'platform' THEN
    v_expected_scope_type := 'tenant';
    v_expected_scope_id := COALESCE(p_scope_id, v_current_org_id);
  ELSIF v_expected_scope_type = 'organization' THEN
    v_expected_scope_type := 'tenant';
  END IF;

  IF v_expected_scope_type = 'tenant' THEN
    v_expected_scope_id := COALESCE(v_expected_scope_id, v_current_org_id);
    IF p_scope_id IS NOT NULL AND p_scope_id <> v_expected_scope_id THEN
      RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 active tenant scope_id is not allowed for this actor'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_actor_scope_type = 'platform'
     AND p_scope_id IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM public.organizations o WHERE o.id = p_scope_id) THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 active tenant scope_id does not exist'
      USING ERRCODE = '22023';
  END IF;

  SELECT *
    INTO v_existing
    FROM public.workflow_run_triggers
   WHERE id = p_workflow_run_trigger_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 workflow run trigger not found'
      USING ERRCODE = 'P0002';
  END IF;

  IF NOT public.workflow_template_scope_allowed(v_existing.scope_type, v_existing.scope_id) THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 workflow run trigger is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_expected_scope_type IN ('tenant', 'client', 'sender')
     AND (v_existing.scope_type <> v_expected_scope_type OR v_existing.scope_id <> v_expected_scope_id) THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 workflow run trigger is outside active scope'
      USING ERRCODE = '42501';
  END IF;

  SELECT count(*)
    INTO v_fire_count
    FROM public.workflow_trigger_fires
   WHERE workflow_run_trigger_id = p_workflow_run_trigger_id;

  UPDATE public.workflow_run_triggers
     SET enabled = FALSE,
         deleted_at = COALESCE(deleted_at, now()),
         deleted_by = COALESCE(deleted_by, auth.uid()),
         delete_reason = COALESCE(delete_reason, 'operator_delete')
   WHERE id = p_workflow_run_trigger_id
   RETURNING * INTO v_updated;

  RETURN jsonb_build_object(
    'status', 'deleted',
    'workflow_run_trigger_id', v_existing.id::text,
    'source_workflow_template_id', v_updated.source_workflow_template_id::text,
    'target_workflow_template_id', v_updated.target_workflow_template_id::text,
    'scope_type', v_updated.scope_type,
    'scope_id', v_updated.scope_id::text,
    'enabled', v_updated.enabled,
    'deleted_at', v_updated.deleted_at,
    'workflow_trigger_fires_count', v_fire_count
  );
END;
$$;

COMMENT ON FUNCTION public.ui_delete_workflow_run_trigger_v1(UUID, UUID)
  IS 'Soft-deletes a row-driven workflow run trigger through Console V2. Capability: workflows.write. Disables the trigger and preserves workflow_trigger_fires lineage for operator readback.';

REVOKE ALL ON FUNCTION public.ui_delete_workflow_run_trigger_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_delete_workflow_run_trigger_v1(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_delete_workflow_run_trigger_v1(
  p_workflow_run_trigger_id UUID,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE sql
VOLATILE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $wrapper$
  SELECT public.ui_delete_workflow_run_trigger_v1(p_workflow_run_trigger_id, p_scope_id);
$wrapper$;

REVOKE ALL ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID)
  IS 'API-schema wrapper for Console V2 workflow run trigger delete lifecycle actions.';

SELECT pg_advisory_unlock(hashtext('202606011430_workflow_run_trigger_lifecycle_rpc_v1'));
COMMIT;
