-- Disposable installed-candidate consumer tests. No workflow/host execution; all rows roll back.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT no_plan();
SELECT has_view('public','webhook_inbox_followup_read_v1','additive inbox projection exists');
SELECT ok((SELECT reloptions @> ARRAY['security_invoker=true'] FROM pg_class
  WHERE oid='public.webhook_inbox_followup_read_v1'::regclass),'new projection is security invoker');
SELECT ok(NOT has_table_privilege('anon','public.webhook_inbox_followup_read_v1','SELECT')
  AND NOT has_table_privilege('authenticated','public.webhook_inbox_followup_read_v1','SELECT')
  AND NOT has_table_privilege('service_role','public.webhook_inbox_followup_read_v1','SELECT'),
  'no direct browser/anonymous/service view access');
SELECT ok(has_table_privilege('ui_rpc_executor','public.webhook_inbox_followup_read_v1','SELECT'),
  'executor has explicit new view SELECT');
SELECT ok(NOT EXISTS(SELECT 1 FROM unnest(ARRAY['INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
  WHERE has_table_privilege('ui_rpc_executor','public.webhook_inbox_followup_read_v1',p)),
  'executor gains no new view write or reference privileges');
SELECT ok(NOT has_table_privilege('service_role','public.webhook_followup_readback_state_v1','SELECT')
  AND NOT has_table_privilege('ui_rpc_executor','public.webhook_followup_readback_state_v1','SELECT')
  AND NOT has_table_privilege('authenticated','public.webhook_followup_readback_state_v1','SELECT'),
  'additive snapshot stays private');
SELECT is(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'),
  (SELECT value#>>'{}' FROM public.webhook_followup_readback_state_v1 WHERE key='baseline_seal'),
  'frozen executor epoch unchanged');
SELECT is(obj_description('public.webhook_followup_readback_state_v1'::regclass,'pg_class'),
  'webhook_followup_readback_state_v1:sha256:' || (SELECT encode(pg_catalog.sha256(convert_to(
    jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex') FROM public.webhook_followup_readback_state_v1),
  'additive evidence remains sealed');
-- Later sealed additive epochs may extend the plan; the executor suite checks exact live ACL equality.
SELECT ok((SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    FROM public.ui_rpc_executor_privilege_plan_v1() p) @>
  (SELECT value FROM public.webhook_followup_readback_state_v1 WHERE key='plan_after'),
  'current plan retains the complete prior follow-up epoch');
SELECT is((SELECT r->>'read_relation' FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id,
  jsonb_array_elements(sv.value->'resources') r WHERE s.category='ui_read_registry'
    AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL AND r->>'key'='webhook_inbox'),
  'public.webhook_inbox_followup_read_v1','canonical root selects the additive read route');

CREATE FUNCTION pg_temp.test_webhook_followup_readback_v1() RETURNS SETOF TEXT LANGUAGE plpgsql AS $test$
DECLARE
  org UUID:=gen_random_uuid(); other_org UUID:=gen_random_uuid(); actor UUID:=gen_random_uuid();
  source_id UUID:=gen_random_uuid(); other_source UUID:=gen_random_uuid(); template_id UUID:=gen_random_uuid();
  inbox_id UUID:=gen_random_uuid(); foreign_inbox UUID:=gen_random_uuid(); entry_id UUID:=gen_random_uuid();
  child_id UUID:=gen_random_uuid(); extra_id UUID:=gen_random_uuid(); client_id UUID:=gen_random_uuid(); sender_id UUID:=gen_random_uuid();
  entry_context JSONB; child_context JSONB; child_metadata JSONB; row_result JSONB;
  action TEXT; state TEXT; scenario TEXT; policy JSONB; registry JSONB; schema_version INT;
  role_key TEXT:='followup_'||replace(gen_random_uuid()::text,'-','');
BEGIN
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (org,'Followup own','followup-'||org,'active'),(other_org,'Followup foreign','followup-'||other_org,'active');
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES(client_id,org,'Followup client','followup-'||client_id,'active');
  INSERT INTO public.senders(id,client_id,name,status) VALUES(sender_id,client_id,'Followup sender','active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
    VALUES(actor,org,actor||'@example.invalid','Followup reader','ops_admin','active','tenant',NULL);
  INSERT INTO public.webhook_sources(id,organization_id,source_identifier,name,provider_type,auth_token,sender_id,enabled)
    VALUES(source_id,org,'followup-'||source_id,'Followup own','generic','synthetic-owned-token',sender_id,TRUE),
      (other_source,other_org,'followup-'||other_source,'Followup foreign','generic','synthetic-foreign-token',NULL,TRUE);
  INSERT INTO public.workflow_templates(id,name,version,status,scope_type,scope_id)
    VALUES(template_id,'followup_readback_'||template_id,1,'active','tenant',org);
  entry_context:=jsonb_build_object('webhook_id',inbox_id,'organization_id',org,
    'source_identifier','followup-'||source_id,'webhook_source_id',source_id,'followup_workflow_run_id',child_id);
  child_context:=(entry_context-'followup_workflow_run_id')||jsonb_build_object('started_by_run_id',entry_id);
  child_metadata:=jsonb_build_object('started_by_run_id',entry_id);
  INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status,context,metadata)
    VALUES(entry_id,template_id,1,'webhook','completed',entry_context,'{}'),
      (child_id,template_id,1,'webhook','pending',child_context,child_metadata);
  INSERT INTO public.webhook_inbox(id,organization_id,webhook_source_id,provider_type,external_id,event_type,
      processing_status,workflow_run_id,raw_payload,transformed_payload)
    VALUES(inbox_id,org,source_id,'generic','followup-'||inbox_id,'shipment.delete','pending',entry_id,'{}','{}'),
      (foreign_inbox,other_org,other_source,'generic','followup-'||foreign_inbox,'shipment.delete','pending',NULL,'{}','{}');

  FOREACH action IN ARRAY ARRAY['cancel','reschedule'] LOOP
    UPDATE public.webhook_inbox SET event_type=CASE action WHEN 'cancel' THEN 'shipment.delete' ELSE 'shipment.reschedule' END WHERE id=inbox_id;
    FOREACH state IN ARRAY ARRAY['pending','completed','failed'] LOOP
      UPDATE public.workflow_runs SET workflow_status=state,last_error=CASE WHEN state='failed'
        THEN '{"message":"shipment_status_not_allowed","authorization":"Bearer synthetic-token","nested":{"api_key":"synthetic-key"}}'::jsonb
        ELSE NULL END WHERE id=child_id;
      SELECT to_jsonb(v) INTO row_result FROM public.webhook_inbox_followup_read_v1 v WHERE v.id=inbox_id;
      RETURN NEXT is(row_result->>'followup_workflow_run_id',child_id::text,action||' '||state||' actual owned child id');
      RETURN NEXT is(row_result->>'followup_workflow_status',state,action||' '||state||' actual owned child status');
      RETURN NEXT is(row_result->>'processing_status','pending',action||' '||state||' engine-owned inbox status unchanged');
      RETURN NEXT ok(CASE WHEN state='failed' THEN row_result#>>'{followup_last_error,message}'='shipment_status_not_allowed'
        AND position('synthetic-token' IN row_result::text)=0 AND position('synthetic-key' IN row_result::text)=0
        ELSE row_result->'followup_last_error'='null'::jsonb END,action||' '||state||' owned error is safe');
    END LOOP;
  END LOOP;

  FOREACH scenario IN ARRAY ARRAY['explicit_null','explicit_empty','explicit_wrong','explicit_number',
    'entry_webhook','entry_webhook_missing','entry_org','entry_org_missing','entry_source','entry_source_missing','entry_source_id',
    'child_webhook_missing','child_webhook','child_org','child_org_missing','child_source','child_source_missing',
    'child_source_id','context_parent','metadata_parent','metadata_shape','metadata_json_null','child_context_shape',
    'both_parents_missing','duplicate_child','duplicate_child_missing_pointer'] LOOP
    UPDATE public.workflow_runs SET context=entry_context WHERE id=entry_id;
    UPDATE public.workflow_runs SET context=child_context,metadata=child_metadata WHERE id=child_id;
    CASE scenario
      WHEN 'explicit_null' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{followup_workflow_run_id}','null') WHERE id=entry_id;
      WHEN 'explicit_empty' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{followup_workflow_run_id}','""') WHERE id=entry_id;
      WHEN 'explicit_wrong' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{followup_workflow_run_id}',to_jsonb(extra_id)) WHERE id=entry_id;
      WHEN 'explicit_number' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{followup_workflow_run_id}','1') WHERE id=entry_id;
      WHEN 'entry_webhook' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{webhook_id}',to_jsonb(extra_id)) WHERE id=entry_id;
      WHEN 'entry_webhook_missing' THEN UPDATE public.workflow_runs SET context=context-'webhook_id' WHERE id=entry_id;
      WHEN 'entry_org' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{organization_id}',to_jsonb(other_org)) WHERE id=entry_id;
      WHEN 'entry_org_missing' THEN UPDATE public.workflow_runs SET context=context-'organization_id' WHERE id=entry_id;
      WHEN 'entry_source' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{source_identifier}','"foreign"') WHERE id=entry_id;
      WHEN 'entry_source_missing' THEN UPDATE public.workflow_runs SET context=context-'source_identifier' WHERE id=entry_id;
      WHEN 'entry_source_id' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{webhook_source_id}',to_jsonb(other_source)) WHERE id=entry_id;
      WHEN 'child_webhook_missing' THEN UPDATE public.workflow_runs SET context=context-'webhook_id' WHERE id=child_id;
      WHEN 'child_webhook' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{webhook_id}',to_jsonb(extra_id)) WHERE id=child_id;
      WHEN 'child_org' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{organization_id}',to_jsonb(other_org)) WHERE id=child_id;
      WHEN 'child_org_missing' THEN UPDATE public.workflow_runs SET context=context-'organization_id' WHERE id=child_id;
      WHEN 'child_source' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{source_identifier}','"foreign"') WHERE id=child_id;
      WHEN 'child_source_missing' THEN UPDATE public.workflow_runs SET context=context-'source_identifier' WHERE id=child_id;
      WHEN 'child_source_id' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{webhook_source_id}',to_jsonb(other_source)) WHERE id=child_id;
      WHEN 'context_parent' THEN UPDATE public.workflow_runs SET context=jsonb_set(context,'{started_by_run_id}',to_jsonb(extra_id)) WHERE id=child_id;
      WHEN 'metadata_parent' THEN UPDATE public.workflow_runs SET metadata=jsonb_build_object('started_by_run_id',extra_id) WHERE id=child_id;
      WHEN 'metadata_shape' THEN UPDATE public.workflow_runs SET metadata='[]' WHERE id=child_id;
      WHEN 'metadata_json_null' THEN UPDATE public.workflow_runs SET metadata='null' WHERE id=child_id;
      WHEN 'child_context_shape' THEN UPDATE public.workflow_runs SET context='[]' WHERE id=child_id;
      WHEN 'both_parents_missing' THEN UPDATE public.workflow_runs SET context=context-'started_by_run_id',metadata='{}' WHERE id=child_id;
      WHEN 'duplicate_child' THEN INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status,context,metadata)
        VALUES(extra_id,template_id,1,'webhook','pending',child_context,child_metadata);
      WHEN 'duplicate_child_missing_pointer' THEN
        UPDATE public.workflow_runs SET context=context-'followup_workflow_run_id' WHERE id=entry_id;
        INSERT INTO public.workflow_runs(id,workflow_template_id,workflow_template_version,entry_point,workflow_status,context,metadata)
          VALUES(extra_id,template_id,1,'webhook','pending',child_context,child_metadata);
    END CASE;
    SELECT to_jsonb(v) INTO row_result FROM public.webhook_inbox_followup_read_v1 v WHERE v.id=inbox_id;
    RETURN NEXT ok(row_result->'followup_workflow_run_id'='null'::jsonb AND row_result->'followup_workflow_status'='null'::jsonb
      AND row_result->'followup_last_error'='null'::jsonb,scenario||' refuses unproved identity');
    RETURN NEXT is(row_result->>'processing_status','pending',scenario||' does not change inbox truth');
    IF scenario IN ('duplicate_child','duplicate_child_missing_pointer') THEN DELETE FROM public.workflow_runs WHERE id=extra_id; END IF;
  END LOOP;
  UPDATE public.workflow_runs SET context=entry_context-'followup_workflow_run_id' WHERE id=entry_id;
  UPDATE public.workflow_runs SET context=child_context,metadata=child_metadata,last_error=NULL WHERE id=child_id;
  RETURN NEXT is((SELECT followup_workflow_run_id FROM public.webhook_inbox_followup_read_v1 WHERE id=inbox_id),child_id,'unique strict fallback');
  UPDATE public.workflow_runs SET context=context-'started_by_run_id' WHERE id=child_id;
  RETURN NEXT is((SELECT followup_workflow_run_id FROM public.webhook_inbox_followup_read_v1 WHERE id=inbox_id),child_id,'metadata-only exact parent is supported');
  UPDATE public.workflow_runs SET context=child_context,metadata=NULL WHERE id=child_id;
  RETURN NEXT is((SELECT followup_workflow_run_id FROM public.webhook_inbox_followup_read_v1 WHERE id=inbox_id),child_id,'context-only exact parent is supported');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM information_schema.columns WHERE table_schema='public'
    AND table_name='webhook_inbox_followup_read_v1' AND column_name IN ('shipment_id','shipment_status','followup_context')),
    'no inferred shipment or run context is added');

  SELECT resolved.policy INTO policy FROM public.resolve_access_control_policy_v1('tenant',org,FALSE) resolved;
  SELECT version INTO schema_version FROM public.schema_registry WHERE category='access_control_policy' AND is_active ORDER BY version DESC LIMIT 1;
  policy:=jsonb_set(policy,'{roles}',policy->'roles'||jsonb_build_array(jsonb_build_object('key',role_key,
    'capability_keys',jsonb_build_array('webhooks.read','workflow_runs.read'))));
  policy:=jsonb_set(policy,'{assignments}',COALESCE(policy->'assignments','{}')||jsonb_build_object('user_id',
    COALESCE(policy#>'{assignments,user_id}','{}')||jsonb_build_object(actor::text,jsonb_build_array(role_key))));
  PERFORM public.upsert_settings_value_v1('access_control_policy','tenant',org,policy,schema_version,'Rollback-only follow-up readback actor');
  SELECT cached_value INTO registry FROM public.settings WHERE category='ui_read_registry'
    AND scope_type=public.get_root_scope_type_key_v1() AND scope_id IS NULL;
  SELECT version INTO schema_version FROM public.schema_registry WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1;
  PERFORM public.upsert_settings_value_v1('ui_read_registry','tenant',org,registry,schema_version,'Rollback-only follow-up presentation');
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  SET LOCAL ROLE authenticated;
  RETURN NEXT is(api.ui_get_resource_v1('webhook_inbox',inbox_id)->>'followup_workflow_run_id',child_id::text,
    'existing authenticated API route returns canonical child');
  RETURN NEXT ok(api.ui_get_resource_v1('webhook_inbox',foreign_inbox) IS NULL,'foreign inbox remains hidden');
  RETURN NEXT throws_ok('SELECT * FROM public.webhook_inbox_followup_read_v1 LIMIT 1','42501',NULL,
    'authenticated cannot bypass generic projection through direct view access');
  RESET ROLE;
END;
$test$;
SELECT * FROM pg_temp.test_webhook_followup_readback_v1();
SELECT * FROM finish();
ROLLBACK;
