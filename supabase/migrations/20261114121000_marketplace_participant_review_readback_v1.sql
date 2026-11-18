-- Additive read-only consumer; the producer and frozen executor rollback epoch are unchanged.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261114121000_marketplace_participant_review_readback_v1'));

DO $preflight$
BEGIN
  LOCK TABLE public.ui_rpc_executor_rollback_state_v1 IN SHARE MODE;
  IF (SELECT relowner FROM pg_class WHERE oid='public.ui_rpc_executor_rollback_state_v1'::regclass)
       IS DISTINCT FROM current_user::regrole::oid THEN
    RAISE EXCEPTION 'Marketplace review installation requires the existing snapshot owner' USING ERRCODE='42501';
  END IF;
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class')
       IS DISTINCT FROM 'ui_rpc_executor_rollback_state_v1:sha256:' || (SELECT
         encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
         FROM public.ui_rpc_executor_rollback_state_v1) THEN
    RAISE EXCEPTION 'Frozen executor snapshot integrity mismatch';
  END IF;
  IF to_regclass('public.marketplace_participant_request_review_read_v1') IS NOT NULL
     OR to_regclass('public.marketplace_review_readback_state_v1') IS NOT NULL THEN
    RAISE EXCEPTION 'Marketplace review projection or its additive epoch already exists';
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

CREATE TABLE public.marketplace_review_readback_state_v1(key TEXT PRIMARY KEY,value JSONB NOT NULL);
INSERT INTO public.table_contracts(table_schema,table_name,created_at_required,updated_at_required,audit_enabled,notes)
VALUES('public','marketplace_review_readback_state_v1',FALSE,FALSE,FALSE,
  'Separate sealed marketplace review read projection epoch; never changes the frozen executor snapshot.');
SELECT public.enforce_service_only_rls_v1('public.marketplace_review_readback_state_v1'::regclass);
REVOKE ALL ON TABLE public.marketplace_review_readback_state_v1 FROM PUBLIC,anon,authenticated,service_role,ui_rpc_executor;

INSERT INTO public.marketplace_review_readback_state_v1 VALUES
 ('baseline_seal',to_jsonb(obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class'))),
 ('plan_before',(SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
   FROM public.ui_rpc_executor_privilege_plan_v1() p));

CREATE VIEW public.marketplace_participant_request_review_read_v1
WITH (security_invoker = true) AS
SELECT
  r.id,
  r.status,
  CASE WHEN r.status = 'pending' AND lower(COALESCE(r.decision_metadata->>'request_additional_docs','false')) IN ('true','t','1','yes')
    THEN 'request_additional_docs' ELSE r.review_decision END AS review_decision,
  r.requested_participant_type_key,
  r.email,
  r.full_name,
  r.organization_name,
  r.organization_slug,
  r.created_at,
  r.reviewed_at,
  r.reviewed_by,
  r.review_reason,
  r.invite_redirect_to,
  r.approved_organization_id,
  r.approved_participant_profile_id,
  r.last_error_code,
  r.last_error_message,
  CASE WHEN r.status = 'pending' AND lower(COALESCE(r.decision_metadata->>'request_additional_docs','false')) IN ('true','t','1','yes')
    THEN (
      SELECT COALESCE(jsonb_agg(doc.value ORDER BY doc.first_ordinal), '[]'::jsonb)
      FROM (
        SELECT btrim(item.value #>> '{}') AS value, min(item.ordinality) AS first_ordinal
        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(r.decision_metadata->'requested_documents') = 'array'
          THEN r.decision_metadata->'requested_documents' ELSE '[]'::jsonb END)
          WITH ORDINALITY AS item(value, ordinality)
        WHERE jsonb_typeof(item.value) = 'string'
          AND length(btrim(item.value #>> '{}')) BETWEEN 1 AND 100
        GROUP BY btrim(item.value #>> '{}')
      ) AS doc
    ) ELSE '[]'::jsonb END AS requested_documents
FROM public.marketplace_participant_requests r
WHERE public.user_has_resource_capability_v1('marketplace_participant_requests', 'read')
  AND (public.is_platform_user()
    OR public.marketplace_org_match_v1(r.requested_organization_id)
    OR public.marketplace_org_match_v1(r.approved_organization_id));

COMMENT ON VIEW public.marketplace_participant_request_review_read_v1 IS
  'Safe review readback follows the canonical active document-request flag; historical decision text cannot reopen a resubmitted request.';
REVOKE ALL ON public.marketplace_participant_request_review_read_v1 FROM PUBLIC,anon,authenticated,service_role,ui_rpc_executor;

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
  object_acl JSONB;
  base_relation OID := 'public.marketplace_participant_requests'::regclass;
BEGIN
  LOCK TABLE public.settings,public.settings_versions IN SHARE ROW EXCLUSIVE MODE;
  LOCK TABLE public.marketplace_participant_requests IN SHARE MODE;
  SELECT s.id,s.category,s.scope_type,s.scope_id,s.scope_hash,s.cached_value,s.settings_version_id,sv.value,sv.schema_version,sv.approved_at,
    sv.effective_until INTO STRICT root FROM public.settings s
    JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
      AND sv.category=s.category AND sv.scope_type=s.scope_type AND sv.scope_id IS NOT DISTINCT FROM s.scope_id
    WHERE s.category='ui_read_registry' AND s.scope_type=public.get_root_scope_type_key_v1() AND s.scope_id IS NULL
    FOR UPDATE OF s,sv;
  IF root.approved_at IS NULL OR root.effective_until IS NOT NULL OR root.value IS DISTINCT FROM root.cached_value
     OR jsonb_typeof(root.value->'resources') IS DISTINCT FROM 'array'
     OR (SELECT count(*) FROM jsonb_array_elements(root.value->'resources') r WHERE r->>'key'='marketplace_participant_requests')<>1 THEN
    RAISE EXCEPTION 'Marketplace review readback requires one approved current global participant-request resource with cache parity';
  END IF;
  IF (SELECT schema#>>'{properties,resources,items,properties,read_relation,type}' FROM public.schema_registry
      WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1) IS DISTINCT FROM 'string' THEN
    RAISE EXCEPTION 'Active registry schema lacks the existing read_relation contract';
  END IF;
  SELECT r INTO STRICT resource FROM jsonb_array_elements(root.value->'resources') r WHERE r->>'key'='marketplace_participant_requests';
  IF resource->>'relation' IS DISTINCT FROM 'public.marketplace_participant_requests'
     OR resource->>'id_column' IS DISTINCT FROM 'id'
     OR resource->>'capability_read' IS DISTINCT FROM 'marketplace_participant_requests.read'
     OR (resource ? 'read_relation' AND resource->>'read_relation' IS DISTINCT FROM 'public.marketplace_participant_requests')
     OR jsonb_typeof(resource->'select') IS DISTINCT FROM 'array' OR jsonb_array_length(resource->'select')=0
     OR EXISTS (SELECT 1 FROM jsonb_array_elements(resource->'select') e WHERE jsonb_typeof(e)<>'string') THEN
    RAISE EXCEPTION 'Participant-request identity/security/projection preimage mismatch';
  END IF;
  IF EXISTS (SELECT 1 FROM unnest(ARRAY[base_relation]) relation
      WHERE NOT has_table_privilege('ui_rpc_executor',relation,'SELECT')) THEN
    RAISE EXCEPTION 'Existing participant-request SELECT is missing';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=ANY(ARRAY[base_relation]) AND
      (NOT c.relrowsecurity OR c.relowner='ui_rpc_executor'::regrole OR NOT EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='ui_rpc_executor_trusted') OR EXISTS (
        SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND 'authenticated'::regrole::oid=ANY(p.polroles)
          AND NOT 'ui_rpc_executor'::regrole::oid=ANY(p.polroles) AND NOT 0=ANY(p.polroles)))) THEN
    RAISE EXCEPTION 'Existing executor dependency RLS/policy applicability mismatch';
  END IF;
  INSERT INTO public.marketplace_review_readback_state_v1
    SELECT 'base_relations',jsonb_agg(jsonb_build_object('relation',c.oid::regclass::text,'owner',c.relowner,
      'rls',c.relrowsecurity,'force_rls',c.relforcerowsecurity,'acl',c.relacl,'policies',(
        SELECT COALESCE(jsonb_agg(jsonb_build_object('name',p.polname,'command',p.polcmd,'permissive',p.polpermissive,
          'roles',p.polroles,'using',pg_get_expr(p.polqual,p.polrelid),'check',pg_get_expr(p.polwithcheck,p.polrelid))
          ORDER BY p.polname),'[]'::jsonb) FROM pg_policy p WHERE p.polrelid=c.oid)) ORDER BY c.oid)
    FROM pg_class c WHERE c.oid=ANY(ARRAY[base_relation]);
  IF EXISTS (SELECT 1 FROM jsonb_array_elements_text(resource->'select') requested(column_name)
      WHERE NOT EXISTS (SELECT 1 FROM pg_attribute a
        WHERE a.attrelid='public.marketplace_participant_request_review_read_v1'::regclass
          AND a.attname=requested.column_name AND a.attnum>0 AND NOT a.attisdropped)) THEN
    RAISE EXCEPTION 'Marketplace safe projection cannot preserve the current registry; reconcile explicitly';
  END IF;
  INSERT INTO public.marketplace_review_readback_state_v1 VALUES ('registry_before',to_jsonb(root));
  next_resource := resource || jsonb_build_object('read_relation','public.marketplace_participant_request_review_read_v1',
    'select',CASE WHEN resource->'select' ? 'requested_documents' THEN resource->'select'
      ELSE resource->'select' || '["requested_documents"]'::jsonb END);
  SELECT jsonb_set(root.value,'{resources}',jsonb_agg(CASE WHEN r->>'key'='marketplace_participant_requests' THEN next_resource ELSE r END ORDER BY n))
    INTO next_value FROM jsonb_array_elements(root.value->'resources') WITH ORDINALITY entries(r,n);
  PERFORM public.upsert_settings_value_v1('ui_read_registry',root.scope_type,root.scope_id,next_value,
    root.schema_version,'Expose safe marketplace additional-document review through canonical root read routing');
  IF (SELECT cached_value FROM public.settings WHERE id=root.id) IS DISTINCT FROM next_value THEN
    RAISE EXCEPTION 'Marketplace review registry normalization changed unrelated metadata';
  END IF;
  INSERT INTO public.marketplace_review_readback_state_v1
    SELECT 'registry_after',jsonb_build_object('settings_id',s.id,'version_id',s.settings_version_id,'value',s.cached_value)
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id AND sv.scope_hash=s.scope_hash
    WHERE s.id=root.id AND s.cached_value=sv.value AND sv.effective_until IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Marketplace review registry pointer/cache parity lost'; END IF;
  SELECT value INTO plan_before FROM public.marketplace_review_readback_state_v1 WHERE key='plan_before';
  SELECT COALESCE(jsonb_agg(to_jsonb(p) ORDER BY object_kind,object_id,privilege,column_name),'[]'::jsonb)
    INTO plan_after FROM public.ui_rpc_executor_privilege_plan_v1() p;
  SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) INTO removed FROM jsonb_array_elements(plan_before) e
    WHERE NOT plan_after @> jsonb_build_array(e);
  SELECT COALESCE(jsonb_agg(e),'[]'::jsonb) INTO delta FROM jsonb_array_elements(plan_after) e
    WHERE NOT plan_before @> jsonb_build_array(e);
  IF removed<>'[]'::jsonb OR NOT delta @> jsonb_build_array(jsonb_build_object('object_kind','relation',
      'object_id','public.marketplace_participant_request_review_read_v1'::regclass::oid,'privilege','SELECT','column_name',NULL))
    OR jsonb_array_length(delta)<>1 THEN
    RAISE EXCEPTION 'Unexpected additive marketplace review privilege-plan delta';
  END IF;
  INSERT INTO public.marketplace_review_readback_state_v1 VALUES ('plan_after',plan_after),('plan_delta',delta);
  -- This epoch owns only its newly created view SELECT, never existing dependency grants.
  IF has_table_privilege('ui_rpc_executor','public.marketplace_participant_request_review_read_v1','SELECT') THEN
    RAISE EXCEPTION 'Unexpected preexisting marketplace view SELECT';
  END IF;
  INSERT INTO public.marketplace_review_readback_state_v1 VALUES ('grant_delta',delta);
  SELECT to_jsonb(relacl) INTO object_acl FROM pg_class WHERE oid='public.marketplace_participant_request_review_read_v1'::regclass;
  INSERT INTO public.marketplace_review_readback_state_v1 VALUES
    ('acl_before:relation:'||'public.marketplace_participant_request_review_read_v1'::regclass::oid,jsonb_build_object('acl',object_acl));
  GRANT SELECT ON public.marketplace_participant_request_review_read_v1 TO ui_rpc_executor;
  IF NOT has_table_privilege('ui_rpc_executor','public.marketplace_participant_request_review_read_v1','SELECT') THEN
    RAISE EXCEPTION 'View SELECT grant did not take effect';
  END IF;
  SELECT to_jsonb(relacl) INTO object_acl FROM pg_class WHERE oid='public.marketplace_participant_request_review_read_v1'::regclass;
  INSERT INTO public.marketplace_review_readback_state_v1 VALUES
    ('acl_after:relation:'||'public.marketplace_participant_request_review_read_v1'::regclass::oid,jsonb_build_object('acl',object_acl));
  INSERT INTO public.marketplace_review_readback_state_v1
    SELECT 'functions',jsonb_agg(jsonb_build_object('signature',p.oid::regprocedure::text,'owner',p.proowner,
      'acl',p.proacl,'definition',pg_get_functiondef(p.oid)) ORDER BY p.oid)
    FROM pg_proc p WHERE p.oid IN (SELECT (e->>'object_id')::oid
      FROM jsonb_array_elements(plan_after) e WHERE e->>'object_kind'='function') OR p.oid IN (
      'public.ui_rpc_executor_privilege_plan_v1()'::regprocedure,
      'public.ui_get_resource_v1(text,uuid)'::regprocedure,
      'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
      'public.ui_update_resource_v1(text,text,jsonb)'::regprocedure,
      'public.ui_delete_resource_v1(text,text)'::regprocedure,
      'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
      'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure,
      'api.ui_get_resource_v1(text,uuid)'::regprocedure,
      'api.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
      'api.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
      'api.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure,
      'public.ui_rpc_registry_v1(text,uuid)'::regprocedure,
      'public.user_has_resource_capability_v1(text,text,text,uuid)'::regprocedure,
      'public.marketplace_org_match_v1(uuid)'::regprocedure,
      'public.is_platform_user()'::regprocedure);
  INSERT INTO public.marketplace_review_readback_state_v1
    SELECT 'view_after',jsonb_build_object('definition',pg_get_viewdef(c.oid,TRUE),'owner',c.relowner,'options',c.reloptions,'acl',c.relacl)
    FROM pg_class c WHERE c.oid='public.marketplace_participant_request_review_read_v1'::regclass;
END;
$install$;

DO $seal$
DECLARE digest TEXT;
BEGIN
  IF obj_description('public.ui_rpc_executor_rollback_state_v1'::regclass,'pg_class') IS DISTINCT FROM
    (SELECT value#>>'{}' FROM public.marketplace_review_readback_state_v1 WHERE key='baseline_seal') THEN
    RAISE EXCEPTION 'Frozen executor seal changed during additive installation';
  END IF;
  SELECT encode(pg_catalog.sha256(convert_to(jsonb_object_agg(key,value ORDER BY key)::text,'UTF8')),'hex')
    INTO digest FROM public.marketplace_review_readback_state_v1;
  EXECUTE format('COMMENT ON TABLE public.marketplace_review_readback_state_v1 IS %L','marketplace_review_readback_state_v1:sha256:'||digest);
END;
$seal$;
DELETE FROM public.settings_cache WHERE cache_key LIKE 'ui_read_registry:%' OR cache_key LIKE '%:marketplace_participant_requests:%';
COMMIT;
