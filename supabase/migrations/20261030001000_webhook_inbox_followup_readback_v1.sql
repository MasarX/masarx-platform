-- Additive read-only consumer; the producer and frozen executor rollback epoch are unchanged.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261030001000_webhook_inbox_followup_readback_v1'));

DO $preflight$
BEGIN
  LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN SHARE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid='public.ui_rpc_executor_rollback_state_v1'::regclass)
       IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Follow-up installation requires the existing snapshot owner' USING ERRCODE='42501';
  END IF;
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class')
       IS DISTINCT FROM 'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT
         encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
         FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'Frozen executor snapshot integrity mismatch';
  END IF;
  IF to_regclass('public.webhook_inbox_followup_read_v1') IS NOT NULL
     OR to_regclass('public.webhook_followup_readback_state_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'Follow-up projection or its additive epoch already exists';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE oid='ui_rpc_executor'::regrole
      AND (rolsuper OR rolbypassrls OR rolinherit OR rolcanlogin)) THEN
    RAISE EXCEPTION 'Unexpected executor role boundary';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member='ui_rpc_executor'::regrole
      OR (m.roleid='ui_rpc_executor'::regrole AND
        (COALESCE((to_jsonb(m)->>'inherit_option')::boolean,TRUE)
          OR COALESCE((to_jsonb(m)->>'set_option')::boolean,TRUE)))) THEN
    RAISE EXCEPTION 'Unexpected executor membership boundary';
  END IF;
END;
$preflight$;

CREATE TABLE public.webhook_followup_readback_state_v1(key TEXT PRIMARY KEY,value JSONB NOT NULL);
INSERT INTO public.table_contracts(table_schema,table_name,created_at_required,updated_at_required,audit_enabled,notes)
VALUES('public','webhook_followup_readback_state_v1',FALSE,FALSE,FALSE,
  'Separate sealed follow-up read projection epoch; never changes the frozen executor snapshot.');
SELECT public.enforce_service_only_rls_v1('public.webhook_followup_readback_state_v1'::regclass);
REVOKE ALL ON TABLE public.webhook_followup_readback_state_v1 FROM PUBLIC,anon,authenticated,service_role,ui_rpc_executor;

INSERT INTO public.webhook_followup_readback_state_v1 VALUES
 ('baseline_seal',to_jsonb(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'))),
 ('plan_before',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
   FROM public.ui_rpc_executor_privilege_plan_v1() p));

CREATE VIEW public.webhook_inbox_followup_read_v1 WITH (security_invoker=true) AS
SELECT inbox.*, child.id AS followup_workflow_run_id,
  child.workflow_status AS followup_workflow_status,
  public.plugin_studio_redact_json_v1(child.last_error,'data',FALSE,NULL,NULL) AS followup_last_error
FROM public.webhook_inbox inbox
LEFT JOIN public.webhook_sources source ON source.id=inbox.webhook_source_id
  AND source.organization_id=inbox.organization_id
LEFT JOIN public.workflow_runs entry ON entry.id=inbox.workflow_run_id
  AND entry.context->>'webhook_id'=inbox.id::text
  AND entry.context->>'organization_id'=inbox.organization_id::text
  AND jsonb_typeof(entry.context->'source_identifier')='string'
  AND entry.context->>'source_identifier'=source.source_identifier
  AND (NOT (entry.context ? 'webhook_source_id') OR entry.context->>'webhook_source_id'=source.id::text)
LEFT JOIN LATERAL (
  SELECT candidate.id,candidate.workflow_status,candidate.last_error
  FROM (
    SELECT run.id,run.workflow_status,run.last_error,count(*) OVER () AS eligible_count
    FROM public.workflow_runs run
    WHERE entry.id IS NOT NULL AND run.id<>entry.id
      AND run.context->>'webhook_id'=inbox.id::text
      AND run.context->>'organization_id'=inbox.organization_id::text
      AND jsonb_typeof(run.context->'source_identifier')='string'
      AND run.context->>'source_identifier'=source.source_identifier
      AND (NOT (run.context ? 'webhook_source_id') OR run.context->>'webhook_source_id'=source.id::text)
      AND (run.metadata IS NULL OR jsonb_typeof(run.metadata)='object')
      AND (run.context->>'started_by_run_id'=entry.id::text OR run.metadata->>'started_by_run_id'=entry.id::text)
      AND (NOT (run.context ? 'started_by_run_id') OR run.context->>'started_by_run_id'=entry.id::text)
      AND (NOT (COALESCE(run.metadata,'{}'::jsonb) ? 'started_by_run_id') OR run.metadata->>'started_by_run_id'=entry.id::text)
  ) candidate
  WHERE candidate.eligible_count=1
    AND (NOT (entry.context ? 'followup_workflow_run_id')
      OR (jsonb_typeof(entry.context->'followup_workflow_run_id')='string'
        AND entry.context->>'followup_workflow_run_id'=candidate.id::text))
) child ON TRUE;
COMMENT ON VIEW public.webhook_inbox_followup_read_v1 IS
  'Owned child id/status/redacted error only. Missing, contradictory or ambiguous lineage yields NULL. Inbox processing truth and shipment/output semantics are unchanged.';
REVOKE ALL ON public.webhook_inbox_followup_read_v1 FROM PUBLIC,anon,authenticated,service_role,ui_rpc_executor;

DO $install$
DECLARE
  root RECORD;
  resource JSONB;
  next_resource JSONB;
  next_value JSONB;
  plan_before JSONB;
  plan_after JSONB;
  delta JSONB;
  removed JSONB;
  rec RECORD;
  object_acl JSONB;
  helpers OID[] := ARRAY[
    'public.plugin_studio_redact_json_v1(jsonb,text,boolean,text,jsonb)'::regprocedure::oid,
    'public.plugin_studio_sensitive_key_v1(text)'::regprocedure::oid,
    'public.plugin_studio_reference_v1(jsonb,jsonb)'::regprocedure::oid,
    'public.plugin_studio_input_v1(jsonb)'::regprocedure::oid,
    'public.plugin_studio_redact_text_v1(text,jsonb)'::regprocedure::oid,
    'public.plugin_studio_rule_source_v1(jsonb)'::regprocedure::oid] || array_remove(ARRAY[
      to_regprocedure('public.plugin_studio_redact_json_v1(jsonb,text,boolean,text)')::oid,
      to_regprocedure('public.plugin_studio_reference_v1(jsonb)')::oid,
      to_regprocedure('public.plugin_studio_redact_text_v1(text)')::oid],NULL);
BEGIN
  LOCK TABLE public.settings,public.settings_versions IN SHARE ROW EXCLUSIVE MODE;
  SELECT s.id,s.scope_type,s.scope_id,s.cached_value,s.settings_version_id,sv.value,sv.schema_version,sv.approved_at,
    sv.effective_until INTO STRICT root FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
      AND sv.category=s.category AND sv.scope_type=s.scope_type AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
    FOR UPDATE OF s,sv;
  IF root.approved_at IS NULL OR root.effective_until IS NOT NULL OR root.value IS DISTINCT FROM root.cached_value
     OR jsonb_typeof(root.value->'resources') IS DISTINCT FROM 'array'
     OR (SELECT count(*) FROM jsonb_array_elements(root.value->'resources') r WHERE r->>'key'='webhook_inbox')<>1 THEN
    RAISE EXCEPTION 'Follow-up readback requires one approved current global inbox resource with cache parity';
  END IF;
  IF (SELECT schema#>>'{properties,resources,items,properties,read_relation,type}' FROM public.schema_registry
      WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Active registry schema lacks the existing read_relation contract';
  END IF;
  SELECT r INTO STRICT resource FROM jsonb_array_elements(root.value->'resources') r WHERE r->>'key'='webhook_inbox';
  IF resource->>'relation' IS DISTINCT FROM 'public.webhook_inbox'
     OR resource->>'id_column' IS DISTINCT FROM 'id'
     OR resource->>'capability_read' IS DISTINCT FROM 'webhooks.read'
     OR resource#>>'{scope_columns,tenant}' IS DISTINCT FROM 'organization_id'
     OR (resource ? 'read_relation' AND resource->>'read_relation' IS DISTINCT FROM 'public.webhook_inbox')
     OR jsonb_typeof(resource->'select') IS DISTINCT FROM 'array' OR jsonb_array_length(resource->'select')=0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(resource->'select') e WHERE jsonb_typeof(e)<>'string') THEN
    RAISE EXCEPTION 'Inbox identity/security/projection preimage mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY['public.webhook_inbox'::regclass,'public.webhook_sources'::regclass,
      'public.workflow_runs'::regclass]) relation
      WHERE NOT has_table_privilege('ui_rpc_executor',relation,'SELECT')) THEN
    RAISE EXCEPTION 'Existing source/entry dependency SELECT is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY['public.webhook_inbox'::regclass::oid,
      'public.webhook_sources'::regclass::oid,'public.workflow_runs'::regclass::oid]) AND
      (NOT c.relrowsecurity OR c.relowner='ui_rpc_executor'::regrole OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='ui_rpc_executor_trusted') OR EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND 'authenticated'::regrole::oid=ANY(p.polroles)
          AND NOT 'ui_rpc_executor'::regrole::oid=ANY(p.polroles) AND NOT 0=ANY(p.polroles)))) THEN
    RAISE EXCEPTION 'Existing executor dependency RLS/policy applicability mismatch';
  END IF;
  INSERT INTO public.webhook_followup_readback_state_v1
    SELECT 'base_relations',jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'owner',c.relowner,
      'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl,'policies',(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
          'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
          ORDER BY p.polname),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.oid)
    FROM pg_class c WHERE c.oid=ANY(ARRAY['public.webhook_inbox'::regclass::oid,
      'public.webhook_sources'::regclass::oid,'public.workflow_runs'::regclass::oid]);
  INSERT INTO public.webhook_followup_readback_state_v1 VALUES ('registry_before',to_jsonb(root));
  next_resource := resource || jsonb_build_object('read_relation','public.webhook_inbox_followup_read_v1',
    'select',resource->'select' || '["followup_workflow_run_id","followup_workflow_status","followup_last_error"]'::jsonb);
  SELECT jsonb_set(root.value,'{resources}',jsonb_agg(CASE WHEN r->>'key'='webhook_inbox' THEN next_resource ELSE r END ORDER BY n))
    INTO next_value FROM jsonb_array_elements(root.value->'resources') WITH ORDINALITY entries(r,n);
  PERFORM public.upsert_settings_value_v1('ui_read_registry',root.scope_type,root.scope_id,next_value,
    root.schema_version,'Expose exact owned webhook follow-up readback through canonical root routing');
  IF (SELECT cached_value FROM public.settings WHERE id=root.id) IS DISTINCT FROM next_value THEN
    RAISE EXCEPTION 'Follow-up registry normalization changed unrelated metadata';
  END IF;
  INSERT INTO public.webhook_followup_readback_state_v1
    SELECT 'registry_after',jsonb_build_object('settings_id',s.id,'version_id',s.settings_version_id,'value',s.cached_value)
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
    WHERE s.id=root.id AND s.cached_value=sv.value AND sv.effective_until IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Follow-up registry pointer/cache parity lost'; END IF;
  SELECT value INTO plan_before FROM public.webhook_followup_readback_state_v1 WHERE key='plan_before';
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    INTO plan_after FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) INTO removed FROM jsonb_array_elements(plan_before) e
    WHERE NOT plan_after @> jsonb_build_array(e);
  SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) INTO delta FROM jsonb_array_elements(plan_after) e
    WHERE NOT plan_before @> jsonb_build_array(e);
  IF removed<>'[]'::jsonb OR NOT delta @> jsonb_build_array(jsonb_build_object('object_kind','relation',
      'object_id','public.webhook_inbox_followup_read_v1'::regclass::oid,'privilege','SELECT','column_name',NULL))
    OR EXISTS (SELECT 1 FROM jsonb_to_recordset(delta) p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
      WHERE p.column_name IS NOT NULL OR NOT ((p.object_kind='relation' AND p.privilege='SELECT'
        AND p.object_id='public.webhook_inbox_followup_read_v1'::regclass)
        OR (p.object_kind='function' AND p.privilege='EXECUTE' AND p.object_id=ANY(helpers)))) THEN
    RAISE EXCEPTION 'Unexpected additive follow-up privilege-plan delta';
  END IF;
  INSERT INTO public.webhook_followup_readback_state_v1 VALUES ('plan_after',plan_after),('plan_delta',delta);
  -- Existing rights can become newly planned; they are never this epoch's grant to revoke.
  SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) INTO delta FROM jsonb_array_elements(delta) e
    WHERE CASE e->>'object_kind'
      WHEN 'relation' THEN NOT has_table_privilege('ui_rpc_executor',(e->>'object_id')::oid,'SELECT')
      WHEN 'function' THEN NOT has_function_privilege('ui_rpc_executor',(e->>'object_id')::oid,'EXECUTE')
      ELSE FALSE END;
  INSERT INTO public.webhook_followup_readback_state_v1 VALUES ('grant_delta',delta);
  FOR rec IN SELECT * FROM jsonb_to_recordset(delta) p(object_kind TEXT,object_id OID,privilege TEXT,column_name TEXT)
    ORDER BY object_kind,object_id LOOP
    IF rec.object_kind='relation' THEN
      SELECT to_jsonb(relacl) INTO object_acl FROM pg_class WHERE oid=rec.object_id;
      EXECUTE format('GRANT SELECT ON TABLE %s TO ui_rpc_executor',rec.object_id::regclass);
      IF NOT has_table_privilege('ui_rpc_executor',rec.object_id,'SELECT') THEN RAISE EXCEPTION 'View SELECT grant did not take effect'; END IF;
    ELSE
      SELECT to_jsonb(proacl) INTO object_acl FROM pg_proc WHERE oid=rec.object_id;
      EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO ui_rpc_executor',rec.object_id::regprocedure);
      IF NOT has_function_privilege('ui_rpc_executor',rec.object_id,'EXECUTE') THEN RAISE EXCEPTION 'Redactor EXECUTE grant did not take effect'; END IF;
    END IF;
    INSERT INTO public.webhook_followup_readback_state_v1 VALUES
      ('acl_before:'||rec.object_kind||':'||rec.object_id,jsonb_build_object('acl',object_acl));
    IF rec.object_kind='relation' THEN SELECT to_jsonb(relacl) INTO object_acl FROM pg_class WHERE oid=rec.object_id;
    ELSE SELECT to_jsonb(proacl) INTO object_acl FROM pg_proc WHERE oid=rec.object_id; END IF;
    INSERT INTO public.webhook_followup_readback_state_v1 VALUES
      ('acl_after:'||rec.object_kind||':'||rec.object_id,jsonb_build_object('acl',object_acl));
  END LOOP;
  INSERT INTO public.webhook_followup_readback_state_v1
    SELECT 'functions',jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,
      'acl',p.proacl,'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid)
    FROM pg_proc p WHERE p.oid=ANY(helpers) OR p.oid IN (
      'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure,
      'public.ui_get_resource_v1(text,uuid)'::regprocedure,
      'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
      'public.ui_update_resource_v1(text,text,jsonb)'::regprocedure,
      'public.ui_delete_resource_v1(text,text)'::regprocedure,
      'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
      'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure);
  INSERT INTO public.webhook_followup_readback_state_v1
    SELECT 'view_after',jsonb_build_object('definition',pg_get_viewdef(c.oid,TRUE),'owner',c.relowner,'options',c.reloptions,'acl',c.relacl)
    FROM pg_class c WHERE c.oid='public.webhook_inbox_followup_read_v1'::regclass;
END;
$install$;

DO $seal$
DECLARE digest TEXT;
BEGIN
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class') IS DISTINCT FROM
    (SELECT value#>>'{}' FROM public.webhook_followup_readback_state_v1 WHERE key='baseline_seal') THEN
    RAISE EXCEPTION 'Frozen executor seal changed during additive installation';
  END IF;
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
    INTO digest FROM public.webhook_followup_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.webhook_followup_readback_state_v1 IS %L','webhook_followup_readback_state_v1:sha256:'||digest);
END;
$seal$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%' OR cache_key LIKE '%:webhook_inbox:%';
COMMIT;
