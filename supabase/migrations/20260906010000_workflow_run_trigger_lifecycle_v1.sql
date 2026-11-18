-- Spec-Issue: #3353 / Preservation: F641 lifecycle
-- Reprojects selected lifecycle semantics onto the current scope/capability/worker contracts.
BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20260906010000_workflow_run_trigger_lifecycle_v1'));

ALTER TABLE public.workflow_run_triggers
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS deleted_by UUID,
  ADD COLUMN IF NOT EXISTS delete_reason TEXT;

CREATE OR REPLACE FUNCTION public.workflow_run_trigger_lifecycle_evidence_v1(
  p_action TEXT,
  p_trigger public.workflow_run_triggers
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_action TEXT := lower(NULLIF(btrim(COALESCE(p_action, '')), ''));
  v_outcome TEXT;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_domain_event_id UUID := gen_random_uuid();
  v_payload JSONB;
BEGIN
  IF p_trigger.id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_trigger_lifecycle_evidence_v1 requires workflow_run_trigger row'
      USING ERRCODE = '23502';
  END IF;

  IF p_trigger.organization_id IS NULL THEN
    RAISE EXCEPTION 'workflow_run_trigger_lifecycle_evidence_v1 requires organization_id for workflow_run_trigger %',
      p_trigger.id
      USING ERRCODE = '23502';
  END IF;

  IF v_action IS NULL OR v_action NOT IN ('create', 'update', 'delete') THEN
    RAISE EXCEPTION 'workflow_run_trigger_lifecycle_evidence_v1 unsupported action %', COALESCE(v_action, 'null')
      USING ERRCODE = '22023';
  END IF;

  v_outcome := CASE
    WHEN v_action = 'create' THEN 'created'
    WHEN v_action = 'delete' THEN 'deleted'
    WHEN p_trigger.enabled IS TRUE THEN 'enabled'
    ELSE 'disabled'
  END;

  v_payload := jsonb_strip_nulls(jsonb_build_object(
    'workflow_run_trigger_id', p_trigger.id,
    'source_workflow_template_id', p_trigger.source_workflow_template_id,
    'target_workflow_template_id', p_trigger.target_workflow_template_id,
    'source_statuses', to_jsonb(p_trigger.source_statuses),
    'scope_type', p_trigger.scope_type,
    'scope_id', p_trigger.scope_id,
    'enabled', p_trigger.enabled,
    'deleted_at', p_trigger.deleted_at,
    'notes', p_trigger.notes,
    'context_patch', p_trigger.context_patch,
    'action', v_action,
    'outcome', v_outcome
  ));

  v_decision_log_id := public.log_decision(
    p_organization_id := p_trigger.organization_id,
    p_decision_category := 'workflow_binding',
    p_resource_type := 'workflow_run_trigger',
    p_resource_id := p_trigger.id,
    p_decision_point := 'workflow_run_trigger.' || v_action,
    p_decision_outcome := v_outcome,
    p_performed_by_system := 'ui_workflow_run_trigger_lifecycle_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := v_payload,
    p_decision_reason := format('Workflow run trigger %s through Console V2.', v_outcome)
  );

  INSERT INTO public.domain_events (
    id,
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload,
    status
  )
  VALUES (
    v_domain_event_id,
    p_trigger.organization_id,
    'workflow_run_trigger.' || v_outcome,
    'workflow_run_trigger',
    p_trigger.id,
    v_correlation_id,
    v_payload || jsonb_build_object('decision_log_id', v_decision_log_id),
    'pending'
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_log_id::text,
    'domain_event_id', v_domain_event_id::text,
    'correlation_id', v_correlation_id::text
  );
END;
$$;

COMMENT ON FUNCTION public.workflow_run_trigger_lifecycle_evidence_v1(TEXT, public.workflow_run_triggers)
  IS 'Writes canonical decision_log and domain_events evidence for Console V2 workflow_run_triggers lifecycle mutations.';

REVOKE ALL ON FUNCTION public.workflow_run_trigger_lifecycle_evidence_v1(TEXT, public.workflow_run_triggers) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[],
  p_context_patch JSONB,
  p_enabled BOOLEAN,
  p_notes TEXT,
  p_scope_id UUID
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
  v_created public.workflow_run_triggers%ROWTYPE;
  v_evidence JSONB;
BEGIN
  IF p_source_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires source_workflow_template_id';
  END IF;
  IF p_target_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_run_trigger_v1 requires target_workflow_template_id';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_actor_scope_type, v_actor_scope_id);

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
    COALESCE(p_source_statuses, ARRAY['completed']::TEXT[]),
    COALESCE(p_context_patch, '{}'::jsonb),
    COALESCE(p_enabled, TRUE),
    auth.uid(),
    NULLIF(btrim(COALESCE(p_notes, '')), '')
  )
  RETURNING * INTO v_created;

  v_evidence := public.workflow_run_trigger_lifecycle_evidence_v1('create', v_created);

  RETURN to_jsonb(v_created) || jsonb_build_object(
    'status', 'ok',
    'workflow_run_trigger_id', v_created.id::text
  ) || v_evidence;
END;
$$;

COMMENT ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'Creates row-driven workflow run triggers through Console V2. Capability: workflow_runs.write. Source and target templates must be visible to the caller scope and lifecycle evidence is written to decision_log/domain_events.';

REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon;
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
  v_evidence JSONB;
BEGIN
  IF p_workflow_run_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 requires workflow_run_trigger_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_actor_scope_type, v_actor_scope_id);

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

  IF NOT public.workflow_template_scope_allowed(v_existing.scope_type, v_existing.scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 workflow run trigger is outside caller scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_expected_scope_type IN ('tenant', 'client', 'sender')
     AND (v_existing.scope_type <> v_expected_scope_type OR v_existing.scope_id <> v_expected_scope_id) THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 workflow run trigger is outside active scope'
      USING ERRCODE = '42501';
  END IF;

  IF v_existing.deleted_at IS NOT NULL THEN
    RAISE EXCEPTION 'ui_update_workflow_run_trigger_v1 cannot update a deleted workflow run trigger'
      USING ERRCODE = '55000';
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

  v_evidence := public.workflow_run_trigger_lifecycle_evidence_v1('update', v_updated);

  RETURN to_jsonb(v_updated) || jsonb_build_object(
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
  ) || v_evidence;
END;
$$;

COMMENT ON FUNCTION public.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'Updates row-driven workflow run trigger configuration through Console V2. Capability: workflow_runs.write. The before-write trigger canonicalizes statuses and scope lineage, and lifecycle evidence is written to decision_log/domain_events.';

REVOKE ALL ON FUNCTION public.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon;
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

REVOKE ALL ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_update_workflow_run_trigger_v1(UUID, UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID)
  IS 'API-schema wrapper for Console V2 workflow run trigger update lifecycle actions with decision/domain evidence readback.';

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
  v_evidence JSONB;
BEGIN
  IF p_workflow_run_trigger_id IS NULL THEN
    RAISE EXCEPTION 'ui_delete_workflow_run_trigger_v1 requires workflow_run_trigger_id'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_actor_scope_type, v_actor_scope_id);

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

  v_evidence := public.workflow_run_trigger_lifecycle_evidence_v1('delete', v_updated);

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
  ) || v_evidence;
END;
$$;

COMMENT ON FUNCTION public.ui_delete_workflow_run_trigger_v1(UUID, UUID)
  IS 'Soft-deletes a row-driven workflow run trigger through Console V2. Capability: workflow_runs.write. Disables the trigger, preserves workflow_trigger_fires lineage, and writes lifecycle evidence to decision_log/domain_events.';

REVOKE ALL ON FUNCTION public.ui_delete_workflow_run_trigger_v1(UUID, UUID) FROM PUBLIC, anon;
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

REVOKE ALL ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID) TO authenticated, service_role;

COMMENT ON FUNCTION api.ui_delete_workflow_run_trigger_v1(UUID, UUID)
  IS 'API-schema wrapper for Console V2 workflow run trigger delete lifecycle actions with decision/domain evidence readback.';



CREATE OR REPLACE FUNCTION public.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID,
  p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL,
  p_context_patch JSONB DEFAULT '{}'::JSONB,
  p_enabled BOOLEAN DEFAULT TRUE,
  p_notes TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $fn$
  SELECT public.ui_create_workflow_run_trigger_v1($1, $2, $3, $4, $5, $6, NULL::UUID);
$fn$;
CREATE OR REPLACE FUNCTION api.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID, p_target_workflow_template_id UUID,
  p_source_statuses TEXT[] DEFAULT NULL, p_context_patch JSONB DEFAULT '{}'::JSONB,
  p_enabled BOOLEAN DEFAULT TRUE, p_notes TEXT DEFAULT NULL
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $fn$ SELECT public.ui_create_workflow_run_trigger_v1($1, $2, $3, $4, $5, $6); $fn$;
CREATE OR REPLACE FUNCTION api.ui_create_workflow_run_trigger_v1(
  p_source_workflow_template_id UUID, p_target_workflow_template_id UUID,
  p_source_statuses TEXT[], p_context_patch JSONB,
  p_enabled BOOLEAN, p_notes TEXT, p_scope_id UUID
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $fn$ SELECT public.ui_create_workflow_run_trigger_v1($1, $2, $3, $4, $5, $6, $7); $fn$;
REVOKE ALL ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_create_workflow_run_trigger_v1(UUID, UUID, TEXT[], JSONB, BOOLEAN, TEXT, UUID) TO authenticated, service_role;


-- This is a fixed relation-security boundary, not configurable business routing.
CREATE OR REPLACE FUNCTION public.ui_assert_generic_mutation_relation_v1(p_relation REGCLASS)
RETURNS VOID LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
AS $fn$
BEGIN
  IF p_relation IS NULL THEN
    RAISE EXCEPTION 'Generic resource mutation requires a resolved relation' USING ERRCODE = '22023';
  END IF;
  IF p_relation = 'public.workflow_run_triggers'::REGCLASS THEN
    RAISE EXCEPTION 'Workflow run trigger mutations require dedicated lifecycle RPCs' USING ERRCODE = '42501';
  END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.ui_assert_generic_mutation_relation_v1(REGCLASS) FROM PUBLIC, anon, authenticated, service_role;

CREATE OR REPLACE FUNCTION public.ui_update_resource_v1(
  p_resource TEXT,
  p_id TEXT,
  p_patch JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_columns JSONB;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_edit_mode TEXT;
  v_edit_permission TEXT;
  v_col_def JSONB;
  v_patch_cols TEXT[] := ARRAY[]::TEXT[];
  v_col TEXT;
  v_col_type TEXT;
  v_set_parts TEXT[] := ARRAY[]::TEXT[];
  v_cols_def TEXT[] := ARRAY[]::TEXT[];
  v_cols_list TEXT[] := ARRAY[]::TEXT[];
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires id';
  END IF;
  IF p_patch IS NULL OR jsonb_typeof(p_patch) <> 'object' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires patch object';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_generic_mutation_relation_v1(to_regclass(format('%I.%I', v_schema, v_table)));

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_update_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  v_columns := v_resource->'columns';
  IF jsonb_typeof(v_columns) <> 'array' THEN
    RAISE EXCEPTION 'ui_update_resource_v1 resource missing column metadata';
  END IF;

  FOR v_col IN SELECT key FROM jsonb_each(p_patch) LOOP
    IF v_col = v_id_column THEN
      RAISE EXCEPTION 'ui_update_resource_v1 cannot update id column';
    END IF;

    SELECT value INTO v_col_def
      FROM jsonb_array_elements(v_columns) AS value
     WHERE value->>'key' = v_col
     LIMIT 1;

    IF v_col_def IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 unknown column %', v_col;
    END IF;

    v_edit_mode := lower(COALESCE(NULLIF(v_col_def->>'edit_mode', ''), 'none'));
    IF v_edit_mode NOT IN ('inline','modal','form') THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not editable: %', v_col;
    END IF;

    v_edit_permission := NULLIF(v_col_def->>'edit_permission', '');
    IF v_edit_permission IS NOT NULL THEN
      PERFORM public.assert_capability_v1(v_edit_permission, v_scope_type, v_scope_id);
    END IF;

    v_patch_cols := array_append(v_patch_cols, v_col);
  END LOOP;

  IF array_length(v_patch_cols, 1) IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 requires editable patch columns';
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 id column not found: %', v_id_column;
  END IF;

  FOR v_col IN SELECT unnest(v_patch_cols) LOOP
    SELECT format_type(a.atttypid, a.atttypmod)
      INTO v_col_type
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = v_schema
       AND c.relname = v_table
       AND a.attname = v_col
       AND a.attnum > 0
       AND a.attisdropped = false
     LIMIT 1;

    IF v_col_type IS NULL THEN
      RAISE EXCEPTION 'ui_update_resource_v1 column not found: %', v_col;
    END IF;

    v_cols_def := array_append(v_cols_def, format('%I %s', v_col, v_col_type));
    v_cols_list := array_append(v_cols_list, format('%I', v_col));
    v_set_parts := array_append(v_set_parts, format('%I = patch.%I', v_col, v_col));
  END LOOP;

  v_sql := format(
    'WITH patch AS (SELECT %s FROM jsonb_to_record($1) AS x(%s)) UPDATE %I.%I AS t SET %s FROM patch WHERE t.%I = $2::%s RETURNING to_jsonb(t.*)',
    array_to_string(v_cols_list, ', '),
    array_to_string(v_cols_def, ', '),
    v_schema,
    v_table,
    array_to_string(v_set_parts, ', '),
    v_id_column,
    v_id_type
  );

  EXECUTE v_sql INTO v_result USING p_patch, p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_update_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_delete_resource_v1(
  p_resource TEXT,
  p_id TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_registry JSONB := public.resolve_settings_merged('ui_read_registry', v_scope_type, v_scope_id);
  v_resource JSONB;
  v_relation TEXT;
  v_schema TEXT;
  v_table TEXT;
  v_id_column TEXT;
  v_id_type TEXT;
  v_capability TEXT;
  v_relkind CHAR;
  v_rls_enabled BOOLEAN;
  v_sql TEXT;
  v_result JSONB;
BEGIN
  IF p_resource IS NULL OR btrim(p_resource) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires resource key';
  END IF;
  IF p_id IS NULL OR btrim(p_id) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 requires id';
  END IF;

  SELECT value INTO v_resource
    FROM jsonb_array_elements(v_registry->'resources') AS value
   WHERE value->>'key' = p_resource
   LIMIT 1;

  IF v_resource IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 unknown resource %', p_resource;
  END IF;

  v_relation := v_resource->>'relation';
  v_id_column := COALESCE(NULLIF(v_resource->>'id_column', ''), 'id');
  v_capability := COALESCE(NULLIF(v_resource->>'capability_write', ''), NULLIF(v_resource->>'capability_read', ''));

  IF v_relation IS NULL OR btrim(v_relation) = '' THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 resource missing relation';
  END IF;

  IF v_capability IS NOT NULL THEN
    PERFORM public.assert_capability_v1(v_capability, v_scope_type, v_scope_id);
  END IF;

  v_schema := split_part(v_relation, '.', 1);
  v_table := split_part(v_relation, '.', 2);
  IF v_table IS NULL OR v_table = '' THEN
    v_schema := 'public';
    v_table := v_relation;
  END IF;

  IF to_regclass(format('%I.%I', v_schema, v_table)) IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not found: %', v_relation;
  END IF;

  PERFORM public.ui_assert_generic_mutation_relation_v1(to_regclass(format('%I.%I', v_schema, v_table)));

  SELECT c.relkind, c.relrowsecurity
    INTO v_relkind, v_rls_enabled
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table;

  IF v_relkind IS NULL OR v_relkind NOT IN ('r','p') THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation not allowed: %', v_relation;
  END IF;

  IF v_rls_enabled IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 relation missing RLS: %', v_relation;
  END IF;

  SELECT format_type(a.atttypid, a.atttypmod)
    INTO v_id_type
    FROM pg_attribute a
    JOIN pg_class c ON c.oid = a.attrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE n.nspname = v_schema
     AND c.relname = v_table
     AND a.attname = v_id_column
     AND a.attnum > 0
     AND a.attisdropped = false
   LIMIT 1;

  IF v_id_type IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 id column not found: %', v_id_column;
  END IF;

  v_sql := format(
    'DELETE FROM %I.%I AS t WHERE t.%I = $1::%s RETURNING to_jsonb(t.*)',
    v_schema,
    v_table,
    v_id_column,
    v_id_type
  );

  EXECUTE v_sql INTO v_result USING p_id;

  IF v_result IS NULL THEN
    RAISE EXCEPTION 'ui_delete_resource_v1 could not find resource % for id %', p_resource, p_id;
  END IF;

  RETURN v_result;
END;
$$;

-- Keep the base RLS read contract intact: fire-history visibility joins retained triggers.
CREATE OR REPLACE VIEW public.workflow_run_triggers_active_v1
WITH (security_invoker = true)
AS SELECT * FROM public.workflow_run_triggers WHERE deleted_at IS NULL;
REVOKE ALL ON public.workflow_run_triggers_active_v1 FROM PUBLIC, anon;
GRANT SELECT ON public.workflow_run_triggers_active_v1 TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON public.workflow_run_triggers FROM PUBLIC, anon, authenticated;
DO $view_grants$
BEGIN
  IF to_regclass('api.workflow_run_triggers') IS NOT NULL THEN
    REVOKE INSERT, UPDATE, DELETE ON api.workflow_run_triggers FROM PUBLIC, anon, authenticated;
  END IF;
END;
$view_grants$;

-- Patch current scoped registry rows too; leave unrelated resources and history untouched.
DO $registry$
DECLARE
  v_setting RECORD;
  v_resources JSONB;
  v_value JSONB;
BEGIN
  FOR v_setting IN
    SELECT s.id, s.settings_version_id, s.scope_type, s.scope_id, sv.schema_version, sv.value
    FROM public.settings s JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    SELECT jsonb_agg(
      CASE WHEN r.value->>'key' = 'workflow_run_triggers' THEN
        r.value || jsonb_build_object(
          'relation', 'public.workflow_run_triggers_active_v1',
          'columns', COALESCE((
            SELECT jsonb_agg(c.value || jsonb_build_object('edit_mode', 'none', 'edit_permission', NULL) ORDER BY c.ordinality)
            FROM jsonb_array_elements(COALESCE(r.value->'columns', '[]'::JSONB)) WITH ORDINALITY c(value, ordinality)
          ), '[]'::JSONB)
        )
      ELSE r.value END ORDER BY r.ordinality
    ) INTO v_resources
    FROM jsonb_array_elements(COALESCE(v_setting.value->'resources', '[]'::JSONB)) WITH ORDINALITY r(value, ordinality);
    v_value := jsonb_set(v_setting.value, '{resources}', COALESCE(v_resources, '[]'::JSONB), TRUE);
    IF v_value IS DISTINCT FROM v_setting.value THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_read_registry', v_setting.scope_type, v_setting.scope_id, v_value,
        v_setting.schema_version, 'Workflow trigger lifecycle-only mutations and active projection'
      );
    END IF;
  END LOOP;
END;
$registry$;

COMMIT;
