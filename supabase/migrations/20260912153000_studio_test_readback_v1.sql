-- DRAFT append-only migration. Caller-authenticated fixed projection; no private material.
BEGIN;
CREATE OR REPLACE FUNCTION public.ui_integration_studio_test_readback_v1(
  p_source_id uuid, p_external_id text, p_inbox_id uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security TO on
AS $function$
DECLARE
  v_org uuid := public.current_user_org_id();
  v_source public.webhook_sources%ROWTYPE;
  v_inbox public.webhook_inbox%ROWTYPE;
  v_shipment_id uuid;
  v_run_id uuid;
  v_step_id uuid;
  v_audit_ids jsonb;
  v_failed boolean;
  v_runs_complete boolean;
  v_entry_present boolean;
  v_matches integer;
BEGIN
  IF auth.uid() IS NULL OR public.current_user_scope_type() IS DISTINCT FROM 'tenant'
     OR v_org IS NULL OR p_source_id IS NULL
     OR NULLIF(p_external_id,'') IS NULL THEN
    RAISE EXCEPTION 'test readback unavailable' USING ERRCODE='42501';
  END IF;
  -- Reuse canonical registry caller access before inspecting any private base records.
  IF public.ui_get_resource_v1('webhook_sources',p_source_id) IS NULL THEN
    RAISE EXCEPTION 'test readback unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_source FROM public.webhook_sources
   WHERE id=p_source_id AND organization_id=v_org AND enabled IS TRUE
     AND managed_metadata->'test_enabled'='true'::jsonb;
  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'test readback unavailable' USING ERRCODE='42501';
  END IF;
  IF p_inbox_id IS NULL THEN
    RETURN jsonb_build_object('state','pending','source_id',p_source_id,'external_id',p_external_id);
  END IF;
  IF public.ui_get_resource_v1('webhook_inbox',p_inbox_id) IS NULL THEN
    RAISE EXCEPTION 'test readback unavailable' USING ERRCODE='42501';
  END IF;
  SELECT * INTO v_inbox FROM public.webhook_inbox
   WHERE id=p_inbox_id AND webhook_source_id=p_source_id
     AND organization_id=v_org AND external_id=p_external_id;
  IF v_source.id IS NULL OR v_inbox.id IS NULL THEN
    RAISE EXCEPTION 'test readback unavailable' USING ERRCODE='42501';
  END IF;
  -- Completed handler output must resolve an actual source-scoped shipment.
  -- A reserved ID, response acknowledgement, or run context alone never passes.
  SELECT count(*),(array_agg(s.id))[1],(array_agg(r.id))[1],(array_agg(step.id))[1]
    INTO v_matches,v_shipment_id,v_run_id,v_step_id
    FROM public.workflow_runs r
    JOIN public.workflow_run_steps step ON step.workflow_run_id=r.id
    JOIN public.shipments s ON s.id::text=step.operation_result->>'shipment_id'
    JOIN public.senders sender ON sender.id=v_source.sender_id
    JOIN public.clients client ON client.id=sender.client_id
   WHERE r.context->>'webhook_id'=v_inbox.id::text
     AND (r.id=v_inbox.workflow_run_id OR r.metadata->>'started_by_run_id'=v_inbox.workflow_run_id::text)
     AND r.context->>'organization_id'=v_org::text
     AND step.handler_key='shipment_create' AND step.step_status='completed'
     AND s.organization_id=v_org AND client.organization_id=v_org
     AND s.client_id=client.id AND s.sender_id=sender.id
   ;
  IF v_matches>1 THEN
    RAISE EXCEPTION 'test readback lineage ambiguous' USING ERRCODE='23514';
  END IF;
  SELECT COALESCE(jsonb_agg(e.decision_log_id ORDER BY e.decision_log_id),'[]'::jsonb)
    INTO v_audit_ids FROM public.webhook_response_events e
   WHERE e.webhook_inbox_id=v_inbox.id AND e.organization_id=v_org
     AND e.workflow_run_id=v_inbox.workflow_run_id
     AND (e.workflow_run_step_id IS NULL OR EXISTS(
       SELECT 1 FROM public.workflow_run_steps audit_step
       WHERE audit_step.id=e.workflow_run_step_id AND audit_step.workflow_run_id=e.workflow_run_id));
  SELECT COALESCE(bool_or(r.workflow_status IN ('failed','cancelled')),false),
         COALESCE(bool_and(r.workflow_status='completed'),false),
         COALESCE(bool_or(r.id=v_inbox.workflow_run_id),false)
    INTO v_failed,v_runs_complete,v_entry_present
    FROM public.workflow_runs r
   WHERE (r.id=v_inbox.workflow_run_id OR r.metadata->>'started_by_run_id'=v_inbox.workflow_run_id::text)
     AND r.context->>'webhook_id'=v_inbox.id::text
     AND r.context->>'organization_id'=v_org::text;
  v_failed:=v_failed OR COALESCE(v_inbox.processing_status::text IN ('failed','cancelled'),false);
  RETURN jsonb_build_object(
    'source_id',v_source.id,'external_id',p_external_id,'inbox_id',v_inbox.id,
    'state',CASE WHEN v_failed THEN 'failed'
                 WHEN v_shipment_id IS NOT NULL AND v_runs_complete AND v_entry_present
                   AND jsonb_array_length(v_audit_ids)>0
                   AND v_inbox.processing_status='succeeded' THEN 'succeeded' ELSE 'pending' END,
    'shipment_id',v_shipment_id,'workflow_run_id',COALESCE(v_run_id,v_inbox.workflow_run_id),
    'workflow_run_step_id',v_step_id,'decision_log_ids',v_audit_ids);
END;
$function$;
REVOKE ALL ON FUNCTION public.ui_integration_studio_test_readback_v1(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_integration_studio_test_readback_v1(uuid,text,uuid) TO authenticated;
CREATE OR REPLACE FUNCTION api.ui_integration_studio_test_readback_v1(p_source_id uuid,p_external_id text,p_inbox_id uuid)
RETURNS jsonb LANGUAGE sql SECURITY INVOKER SET search_path TO public,extensions,pg_temp
AS $$ SELECT public.ui_integration_studio_test_readback_v1(p_source_id,p_external_id,p_inbox_id); $$;
REVOKE ALL ON FUNCTION api.ui_integration_studio_test_readback_v1(uuid,text,uuid) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.ui_integration_studio_test_readback_v1(uuid,text,uuid) TO authenticated;
COMMIT;
