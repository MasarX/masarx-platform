-- F675 review draft: append-only reads only. No financial command exposure.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

CREATE FUNCTION public.ui_get_financial_task_context_v1(p_task_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $fn$
DECLARE
  t public.tasks%ROWTYPE;
  task_type public.task_types%ROWTYPE;
  batch jsonb;
  policy jsonb;
  task_policy jsonb;
  required_type text;
  require_branch boolean := false;
  required_statuses jsonb := '["completed"]'::jsonb;
  requires_session boolean := false;
  required_branch_id uuid;
  sessions jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF NOT public.is_platform_user() AND public.current_user_scope_type() IS DISTINCT FROM 'tenant' THEN
    RAISE EXCEPTION 'transition_task_v1 requires tenant/platform write scope' USING ERRCODE='42501';
  END IF;
  IF public.ui_get_resource_v1('tasks',p_task_id) IS NULL THEN
    RAISE EXCEPTION 'Task not visible' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task_id;
  IF NOT public.user_has_permission_v1('tasks.complete',t.organization_id) THEN
    RAISE EXCEPTION 'Financial task action denied' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT task_type FROM public.task_types WHERE id=t.task_type_id;
  IF t.resource_type IS DISTINCT FROM 'settlement_batch' OR t.resource_id IS NULL
    OR task_type.metadata->'completion_amount_contract' IS DISTINCT FROM
      '{"version":1,"field":"amount","minimum":0}'::jsonb THEN RETURN NULL; END IF;
  -- Registry scope plus canonical settlement authorization: definer reads must
  -- not assume table RLS will run under their owner role.
  IF NOT public.can_read_settlement_batch_v1(t.organization_id,t.resource_id) THEN
    RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501';
  END IF;
  batch:=public.ui_get_resource_v1('settlements',t.resource_id);
  IF batch IS NULL THEN RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501'; END IF;
  SELECT b.branch_id INTO required_branch_id FROM public.settlement_batches b
    WHERE b.id=t.resource_id AND b.organization_id=t.organization_id;
  IF NOT FOUND THEN RETURN NULL; END IF;
  SELECT r.value INTO policy FROM public.resolve_settings_row_from_policy_context_v1(
    'task_ops_session_policy',jsonb_strip_nulls(jsonb_build_object(
      'organization_id',t.organization_id,'client_id',t.client_id,
      'sender_id',t.sender_id,'resource_id',required_branch_id))) r LIMIT 1;
  policy:=COALESCE(policy,'{}'::jsonb);
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object' THEN policy:='{}'::jsonb; END IF;
  task_policy:=COALESCE(policy#>ARRAY['task_type_map',task_type.key],'{}'::jsonb);
  IF jsonb_typeof(task_policy) IS DISTINCT FROM 'object' THEN task_policy:='{}'::jsonb; END IF;
  required_statuses:=COALESCE(policy#>'{defaults,required_on_statuses}',required_statuses);
  BEGIN require_branch:=COALESCE((policy#>>'{defaults,require_branch_match}')::boolean,require_branch);
  EXCEPTION WHEN others THEN require_branch:=require_branch; END;
  required_type:=NULLIF(btrim(COALESCE(task_policy->>'required_session_type','')),'');
  required_statuses:=COALESCE(task_policy->'required_on_statuses',required_statuses);
  BEGIN require_branch:=COALESCE((task_policy->>'require_branch_match')::boolean,require_branch);
  EXCEPTION WHEN others THEN require_branch:=require_branch; END;
  requires_session:=required_type IS NOT NULL AND COALESCE(
    jsonb_typeof(required_statuses)='array' AND 'completed' IN (SELECT jsonb_array_elements_text(required_statuses)),false);
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'session_type',s.session_type,'branch_id',s.branch_id,'opened_at',s.opened_at)
    ORDER BY s.opened_at,s.id),'[]'::jsonb) INTO sessions
  FROM public.ops_sessions s
  WHERE requires_session AND s.organization_id=t.organization_id AND s.actor_user_id=auth.uid()
    AND lower(COALESCE(s.session_type,''))=required_type AND s.closed_at IS NULL
    AND (NOT require_branch OR required_branch_id IS NULL OR s.branch_id=required_branch_id);
  RETURN jsonb_build_object('version',1,'actor_id',auth.uid(),'task_id',t.id,
    'organization_id',t.organization_id,'task_type_key',task_type.key,
    'settlement_id',t.resource_id,'task_status',t.status,
    'amount_contract',task_type.metadata->'completion_amount_contract',
    'requires_session',requires_session,'required_session_type',required_type,'sessions',sessions);
END;
$fn$;

CREATE FUNCTION public.ui_get_financial_task_readback_v1(p_task_id uuid,p_task_event_id uuid)
RETURNS jsonb LANGUAGE plpgsql STABLE SECURITY DEFINER
SET search_path TO public, extensions, pg_temp AS $fn$
DECLARE
  t public.tasks%ROWTYPE;
  e public.task_events%ROWTYPE;
  s public.ops_sessions%ROWTYPE;
  batch jsonb;
BEGIN
  IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication required' USING ERRCODE='42501'; END IF;
  IF public.ui_get_resource_v1('tasks',p_task_id) IS NULL THEN
    RAISE EXCEPTION 'Task not visible' USING ERRCODE='42501';
  END IF;
  SELECT * INTO STRICT t FROM public.tasks WHERE id=p_task_id;
  IF t.resource_type IS DISTINCT FROM 'settlement_batch' OR t.resource_id IS NULL THEN RETURN NULL; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.task_types tt WHERE tt.id=t.task_type_id
    AND tt.metadata->'completion_amount_contract'='{"version":1,"field":"amount","minimum":0}'::jsonb) THEN RETURN NULL; END IF;
  IF NOT public.can_read_settlement_batch_v1(t.organization_id,t.resource_id) THEN
    RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501';
  END IF;
  batch:=public.ui_get_resource_v1('settlements',t.resource_id);
  IF batch IS NULL THEN RAISE EXCEPTION 'Settlement not visible' USING ERRCODE='42501'; END IF;
  IF NOT EXISTS(SELECT 1 FROM public.settlement_batches b
    WHERE b.id=t.resource_id AND b.organization_id=t.organization_id) THEN RETURN NULL; END IF;
  SELECT * INTO e FROM public.task_events WHERE id=p_task_event_id AND task_id=t.id
    AND organization_id=t.organization_id AND actor_user_id=auth.uid()
    AND event_type='status_changed' AND to_status='completed';
  IF NOT FOUND THEN RETURN NULL; END IF;
  PERFORM public.assert_task_completion_amount_v1(e.payload);
  IF e.ops_session_id IS NOT NULL THEN
    SELECT * INTO s FROM public.ops_sessions WHERE id=e.ops_session_id
      AND organization_id=e.organization_id AND actor_user_id=e.actor_user_id;
    IF NOT FOUND THEN RETURN NULL; END IF;
  END IF;
  -- Historical accepted session can now be closed; never require it to stay open.
  RETURN jsonb_build_object('version',1,'task_id',t.id,'task_event_id',e.id,
    'actor_id',e.actor_user_id,'organization_id',e.organization_id,
    'task_status',t.status,'event_status',e.to_status,'amount',e.payload->'amount',
    'ops_session_id',s.id,'session_type',s.session_type,'settlement_id',t.resource_id,
    'settlement_status',batch->'status');
END;
$fn$;

REVOKE ALL ON FUNCTION public.ui_get_financial_task_context_v1(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION public.ui_get_financial_task_readback_v1(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_get_financial_task_context_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_get_financial_task_readback_v1(uuid,uuid) TO authenticated;
CREATE FUNCTION api.ui_get_financial_task_context_v1(p_task_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,extensions,pg_temp AS $fn$
 SELECT public.ui_get_financial_task_context_v1(p_task_id);
$fn$;
CREATE FUNCTION api.ui_get_financial_task_readback_v1(p_task_id uuid,p_task_event_id uuid)
RETURNS jsonb LANGUAGE sql STABLE SECURITY INVOKER
SET search_path TO public,extensions,pg_temp AS $fn$
 SELECT public.ui_get_financial_task_readback_v1(p_task_id,p_task_event_id);
$fn$;
REVOKE ALL ON FUNCTION api.ui_get_financial_task_context_v1(uuid) FROM PUBLIC,anon;
REVOKE ALL ON FUNCTION api.ui_get_financial_task_readback_v1(uuid,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.ui_get_financial_task_context_v1(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_get_financial_task_readback_v1(uuid,uuid) TO authenticated;
COMMIT;
