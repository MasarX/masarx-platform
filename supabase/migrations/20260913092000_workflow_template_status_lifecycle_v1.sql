BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

SELECT pg_advisory_xact_lock(hashtext('20260913092000_workflow_template_status_lifecycle_v1'));

CREATE OR REPLACE FUNCTION public.ui_set_workflow_template_status_v1(
  p_workflow_template_id UUID,
  p_status TEXT,
  p_reason TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_actor_id UUID := auth.uid();
  v_actor_org_id UUID := public.current_user_org_id();
  v_next_status TEXT := lower(btrim(COALESCE(p_status, '')));
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_template public.workflow_templates%ROWTYPE;
  v_now TIMESTAMPTZ := statement_timestamp();
  v_correlation_id UUID := gen_random_uuid();
  v_previous_correlation TEXT := current_setting('request.correlation_id', TRUE);
  v_decision_id UUID;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;
  IF p_workflow_template_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires workflow_template_id'
      USING ERRCODE = '23502';
  END IF;
  IF v_reason IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires reason'
      USING ERRCODE = '23502';
  END IF;
  IF v_next_status NOT IN ('draft', 'active', 'archived')
     OR NOT public.is_active_lookup_value_v1('workflow_status', v_next_status, TRUE) THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 invalid status %', v_next_status
      USING ERRCODE = '22023';
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write');

  SELECT * INTO v_template
    FROM public.workflow_templates
   WHERE id = p_workflow_template_id
     AND public.workflow_template_scope_allowed(scope_type, scope_id)
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 template unavailable'
      USING ERRCODE = 'P0002';
  END IF;
  IF v_template.scope_type = public.get_root_scope_type_key_v1()
     OR v_template.status = 'active'
     OR v_next_status = 'active' THEN
    PERFORM public.assert_capability_v1('system.write');
  END IF;
  IF v_actor_org_id IS NULL THEN
    RAISE EXCEPTION 'ui_set_workflow_template_status_v1 requires actor organization for audit'
      USING ERRCODE = '42501';
  END IF;

  IF v_template.status = v_next_status THEN
    RETURN jsonb_build_object(
      'status', 'ok', 'changed', FALSE, 'workflow_template_id', v_template.id,
      'previous_status', v_template.status, 'next_status', v_next_status
    );
  END IF;

  BEGIN
    PERFORM set_config('request.correlation_id', v_correlation_id::TEXT, TRUE);
    UPDATE public.workflow_templates
       SET status = v_next_status,
           published_at = CASE WHEN v_next_status = 'active' THEN COALESCE(published_at, v_now) ELSE published_at END,
           retired_at = CASE WHEN v_next_status = 'archived' THEN v_now WHEN status = 'archived' THEN NULL ELSE retired_at END
     WHERE id = v_template.id;

    v_decision_id := public.log_decision(
      p_organization_id := v_actor_org_id,
      p_decision_category := 'workflow_binding',
      p_resource_type := 'workflow_template',
      p_resource_id := v_template.id,
      p_decision_point := 'workflow_template.status_transition',
      p_decision_outcome := v_next_status,
      p_performed_by_system := 'ui_set_workflow_template_status_v1',
      p_correlation_id := v_correlation_id,
      p_decision_inputs := jsonb_build_object(
        'actor_user_id', v_actor_id, 'reason', v_reason,
        'previous_status', v_template.status, 'next_status', v_next_status,
        'occurred_at', v_now
      ),
      p_decision_reason := v_reason
    );
    PERFORM public.enqueue_domain_event(
      v_actor_org_id, 'workflow_template.status_changed', 'workflow_template', v_template.id,
      jsonb_build_object(
        'actor_user_id', v_actor_id, 'reason', v_reason,
        'previous_status', v_template.status, 'next_status', v_next_status,
        'occurred_at', v_now, 'decision_log_id', v_decision_id
      ),
      v_correlation_id
    );
    PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
    RAISE;
  END;

  RETURN jsonb_build_object(
    'status', 'ok', 'changed', TRUE, 'workflow_template_id', v_template.id,
    'previous_status', v_template.status, 'next_status', v_next_status,
    'correlation_id', v_correlation_id, 'decision_log_id', v_decision_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_set_workflow_template_status_v1(
  p_workflow_template_id UUID, p_status TEXT, p_reason TEXT
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_set_workflow_template_status_v1($1, $2, $3);
$function$;

CREATE OR REPLACE FUNCTION public.ui_assert_generic_mutation_relation_v1(p_relation REGCLASS)
RETURNS VOID LANGUAGE plpgsql STABLE
SET search_path TO public, pg_temp
AS $function$
BEGIN
  IF p_relation IS NULL THEN
    RAISE EXCEPTION 'Generic resource mutation requires a resolved relation' USING ERRCODE = '22023';
  END IF;
  IF p_relation = 'public.workflow_run_triggers'::REGCLASS THEN
    RAISE EXCEPTION 'Workflow run trigger mutations require dedicated lifecycle RPCs' USING ERRCODE = '42501';
  END IF;
  IF p_relation = 'public.driver_compliance_events'::REGCLASS THEN
    RAISE EXCEPTION 'Compliance events require dedicated append-only RPCs' USING ERRCODE = '42501';
  END IF;
  IF p_relation = 'public.workflow_templates'::REGCLASS THEN
    RAISE EXCEPTION 'Workflow template mutations require dedicated lifecycle RPCs' USING ERRCODE = '42501';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_set_workflow_template_status_v1(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.ui_set_workflow_template_status_v1(UUID, TEXT, TEXT) TO authenticated, service_role;
REVOKE ALL ON FUNCTION api.ui_set_workflow_template_status_v1(UUID, TEXT, TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.ui_set_workflow_template_status_v1(UUID, TEXT, TEXT) TO authenticated, service_role;
REVOKE INSERT, UPDATE, DELETE ON TABLE public.workflow_templates FROM authenticated;
REVOKE ALL ON FUNCTION public.ui_assert_generic_mutation_relation_v1(REGCLASS) FROM PUBLIC, anon, authenticated, service_role;

COMMIT;
