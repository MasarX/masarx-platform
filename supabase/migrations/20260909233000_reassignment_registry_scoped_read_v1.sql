BEGIN;
SET LOCAL lock_timeout = '10s';
SELECT pg_advisory_xact_lock(hashtext('20260909233000_reassignment_registry_scoped_read_v1'));
CREATE OR REPLACE VIEW public.route_stop_reassignment_events_read_v1 WITH (security_invoker=true) AS
SELECT id,organization_id,route_stop_id,shipment_id,source_route_run_id,target_route_run_id,
 event_type,actor_user_id,notes,payload,created_at
FROM public.route_stop_reassignment_events
WHERE public.current_user_scope_type()='tenant'
 AND organization_id=public.current_user_org_id()
 AND organization_id=public.current_user_scope_id()
 AND public.user_has_capability_v1('routes.read','tenant',public.current_user_scope_id());
REVOKE ALL ON public.route_stop_reassignment_events_read_v1 FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION public.ui_assert_resource_read_scope_v1(p_resource JSONB,p_scope TEXT,p_scope_id UUID)
RETURNS VOID LANGUAGE plpgsql STABLE SET search_path TO public,extensions,pg_temp AS $guard$
DECLARE v_allowed JSONB := p_resource->'read_scope_types';
BEGIN
 IF NOT (p_resource ? 'read_scope_types') THEN RETURN; END IF;
 IF jsonb_typeof(v_allowed) IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'Invalid resource read scope policy' USING ERRCODE='23514';
 END IF;
 IF jsonb_array_length(v_allowed)=0 OR EXISTS (
   SELECT 1 FROM jsonb_array_elements(v_allowed) e
   WHERE jsonb_typeof(e) IS DISTINCT FROM 'string'
     OR (e #>> '{}') NOT IN ('tenant','client','sender','platform','global')
 ) THEN RAISE EXCEPTION 'Invalid resource read scope policy' USING ERRCODE='23514'; END IF;
 IF (SELECT count(*)<>count(DISTINCT e) FROM jsonb_array_elements(v_allowed) e) THEN
   RAISE EXCEPTION 'Duplicate resource read scopes' USING ERRCODE='23514';
 END IF;
 IF p_scope IS NULL OR NOT (v_allowed ? p_scope) THEN
   RAISE EXCEPTION 'Resource read scope denied' USING ERRCODE='42501';
 END IF;
 IF p_scope IN ('tenant','client','sender') AND
   (p_scope_id IS NULL OR jsonb_typeof(p_resource->'scope_columns'->p_scope) IS DISTINCT FROM 'string'
    OR NULLIF(btrim(p_resource#>>ARRAY['scope_columns',p_scope]),'') IS NULL) THEN
   RAISE EXCEPTION 'Resource read scope binding missing' USING ERRCODE='42501';
 END IF;
END;
$guard$;
REVOKE ALL ON FUNCTION public.ui_assert_resource_read_scope_v1(JSONB,TEXT,UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_assert_resource_read_scope_v1(JSONB,TEXT,UUID) TO authenticated,service_role;
DO $callers$
DECLARE v_fn REGPROCEDURE; v_def TEXT; v_marker TEXT := '  v_relation := COALESCE(NULLIF(btrim(v_resource->>''read_relation''), ''''), v_resource->>''relation'');';
 v_call TEXT := '  PERFORM public.ui_assert_resource_read_scope_v1(v_resource, v_scope_type, v_scope_id);';
BEGIN
 FOREACH v_fn IN ARRAY ARRAY[
 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
 'public.ui_get_resource_v1(text,uuid)'::regprocedure,
 'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
 'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure] LOOP
   v_def := pg_get_functiondef(v_fn);
   IF (SELECT proowner FROM pg_proc WHERE oid=v_fn) IS DISTINCT FROM
      (SELECT relowner FROM pg_class WHERE oid='public.route_stop_reassignment_events_read_v1'::regclass) THEN
     RAISE EXCEPTION 'Resource reader/view ownership mismatch for %',v_fn;
   END IF;
   IF position(v_call IN v_def)>0 THEN CONTINUE; END IF;
   IF (length(v_def)-length(replace(v_def,v_marker,'')))/length(v_marker)<>1 THEN
     RAISE EXCEPTION 'Expected exactly one resource read seam in %',v_fn;
   END IF;
   EXECUTE replace(v_def,v_marker,v_call || E'\n' || v_marker);
 END LOOP;
END;
$callers$;
DO $registry$
DECLARE v_schema public.schema_registry%ROWTYPE; v_version INT; r RECORD;
 v_resources JSONB; v_existing JSONB; v_next JSONB; v_count INT;
 v_resource JSONB := jsonb_build_object(
 'key','route_stop_reassignment_events','relation','public.route_stop_reassignment_events',
 'read_relation','public.route_stop_reassignment_events_read_v1',
 'id_column','id','capability_read','routes.read',
 'scope_columns',jsonb_build_object('tenant','organization_id'),
 'read_scope_types',jsonb_build_array('tenant'),
 'default_sort',jsonb_build_object('column','created_at','direction','desc'),
 'select',jsonb_build_array('id','organization_id','route_stop_id','shipment_id','source_route_run_id','target_route_run_id','event_type','actor_user_id','notes','payload','created_at'),
 'filters',jsonb_build_array(
 jsonb_build_object('key','route_stop_id','column','route_stop_id','op','eq'),
 jsonb_build_object('key','shipment_id','column','shipment_id','op','eq'),
 jsonb_build_object('key','source_route_run_id','column','source_route_run_id','op','eq'),
 jsonb_build_object('key','target_route_run_id','column','target_route_run_id','op','eq')));
BEGIN
 LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT v_schema FROM public.schema_registry
 WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF jsonb_typeof(v_schema.schema#>'{properties,resources,items,properties}') IS DISTINCT FROM 'object' THEN
   RAISE EXCEPTION 'Malformed UI registry schema';
 END IF;
 IF v_schema.schema#>'{properties,resources,items,properties,read_scope_types}' =
 '{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","enum":["tenant","client","sender","platform","global"]}}'::jsonb THEN
   v_version := v_schema.version;
 ELSE
 IF v_schema.schema#>'{properties,resources,items,properties,read_scope_types}' IS NOT NULL THEN
   RAISE EXCEPTION 'Existing read scope schema differs from the reviewed contract';
 END IF;
 SELECT COALESCE(MAX(version),0)+1 INTO v_version FROM public.schema_registry WHERE category='ui_read_registry';
 INSERT INTO public.schema_registry(category,version,schema,description,examples,is_active)
 VALUES('ui_read_registry',v_version,jsonb_set(v_schema.schema,
 '{properties,resources,items,properties,read_scope_types}',
 '{"type":"array","minItems":1,"uniqueItems":true,"items":{"type":"string","enum":["tenant","client","sender","platform","global"]}}'::jsonb,TRUE),
 'Optional explicit resource read scope policy',v_schema.examples,TRUE);
 UPDATE public.schema_registry SET is_active=FALSE
 WHERE category='ui_read_registry' AND version<>v_version AND is_active;
 END IF;
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
 AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved UI registry baseline missing'; END IF;
 FOR r IN SELECT s.scope_type,s.scope_id,s.cached_value FROM public.settings s
 WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE LOOP
   IF jsonb_typeof(r.cached_value) IS DISTINCT FROM 'object'
     OR jsonb_typeof(r.cached_value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Malformed UI registry resources';
   END IF;
   v_resources := r.cached_value->'resources';
   SELECT count(*) INTO v_count FROM jsonb_array_elements(v_resources) e
   WHERE e->>'key'='route_stop_reassignment_events';
   IF v_count>1 THEN RAISE EXCEPTION 'Duplicate reassignment registry resource'; END IF;
   IF v_count=0 THEN
     v_resources := v_resources || jsonb_build_array(v_resource);
   ELSE
     SELECT e INTO v_existing FROM jsonb_array_elements(v_resources) e
     WHERE e->>'key'='route_stop_reassignment_events';
     -- Explicit read relations, scope/capability policies and select overrides remain owned.
     IF v_existing ? 'read_scope_types' OR v_existing ? 'read_relation'
       OR v_existing->>'relation' IS DISTINCT FROM 'public.route_stop_reassignment_events'
       OR v_existing->>'capability_read' IS DISTINCT FROM 'routes.read'
       OR v_existing->'scope_columns' IS DISTINCT FROM '{"tenant":"organization_id"}'::jsonb
       OR v_existing ? 'select' THEN CONTINUE; END IF;
     SELECT jsonb_agg(CASE WHEN e->>'key'='route_stop_reassignment_events'
       THEN e || jsonb_build_object('read_scope_types',v_resource->'read_scope_types','select',v_resource->'select',
         'read_relation',v_resource->'read_relation')
       ELSE e END ORDER BY n) INTO v_resources
     FROM jsonb_array_elements(v_resources) WITH ORDINALITY x(e,n);
   END IF;
   v_next := jsonb_set(r.cached_value,'{resources}',v_resources);
   IF v_next IS DISTINCT FROM r.cached_value THEN
     PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,
       v_next,v_version,'Restore tenant-only reassignment event registry readback');
   END IF;
 END LOOP;
END;
$registry$;
COMMIT;
