BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20260912220000_workflow_registry_scope_acl_repair_v1'));
-- Explicit JWT predicates remain effective inside the definer-owned registry readers.
CREATE VIEW public.workflow_templates_read_v1 WITH (security_invoker=true) AS
SELECT t.* FROM public.workflow_templates t
WHERE COALESCE(auth.jwt()->>'role','')='service_role'
 OR (COALESCE(auth.jwt()->>'role','')='authenticated'
 AND public.workflow_template_scope_allowed(t.scope_type,t.scope_id));
CREATE VIEW public.workflow_template_steps_read_v1 WITH (security_invoker=true) AS
SELECT s.* FROM public.workflow_template_steps s
JOIN public.workflow_templates t ON t.id=s.workflow_template_id
WHERE COALESCE(auth.jwt()->>'role','')='service_role'
 OR (COALESCE(auth.jwt()->>'role','')='authenticated'
 AND public.workflow_template_scope_allowed(t.scope_type,t.scope_id));
REVOKE ALL ON public.workflow_templates_read_v1,public.workflow_template_steps_read_v1
 FROM PUBLIC,anon,authenticated,service_role;
REVOKE EXECUTE ON FUNCTION public.ui_list_resource_v1(TEXT,JSONB,INTEGER,INTEGER,JSONB),
 public.ui_get_resource_v1(TEXT,UUID),public.ui_filter_distinct_values_v1(TEXT,TEXT,TEXT,INTEGER)
 FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_list_resource_v1(TEXT,JSONB,INTEGER,INTEGER,JSONB),
 public.ui_get_resource_v1(TEXT,UUID),public.ui_filter_distinct_values_v1(TEXT,TEXT,TEXT,INTEGER)
 TO authenticated,service_role;
REVOKE EXECUTE ON FUNCTION public.ui_assert_read_relation_allowed_v1(TEXT,TEXT,TEXT,TEXT)
 FROM PUBLIC,anon,authenticated,service_role;
DO $owners$
DECLARE reader REGPROCEDURE; relation REGCLASS;
BEGIN
 FOREACH reader IN ARRAY ARRAY[
 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
 'public.ui_get_resource_v1(text,uuid)'::regprocedure,
 'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
 'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure] LOOP
   FOREACH relation IN ARRAY ARRAY['public.workflow_templates_read_v1'::regclass,
     'public.workflow_template_steps_read_v1'::regclass] LOOP
     IF (SELECT proowner FROM pg_proc WHERE oid=reader) IS DISTINCT FROM
        (SELECT relowner FROM pg_class WHERE oid=relation) THEN
       RAISE EXCEPTION 'Resource reader/view ownership mismatch for %',reader;
     END IF;
   END LOOP;
 END LOOP;
END;
$owners$;
DO $registry$
DECLARE r RECORD; resource JSONB; resources JSONB; next_value JSONB; selected_count INT; resource_key TEXT;
 active_schema public.schema_registry%ROWTYPE;
BEGIN
 LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO STRICT active_schema FROM public.schema_registry
 WHERE category='ui_read_registry' AND is_active ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF active_schema.schema#>>'{properties,resources,items,properties,read_relation,type}' IS DISTINCT FROM 'string' THEN
   RAISE EXCEPTION 'Active UI registry schema lacks the read relation contract';
 END IF;
 PERFORM 1 FROM public.settings WHERE category='ui_read_registry' ORDER BY id FOR UPDATE;
 IF EXISTS (
   SELECT 1 FROM public.settings s LEFT JOIN public.settings_versions v
   ON v.id=s.settings_version_id AND v.scope_hash=s.scope_hash AND v.category=s.category
   WHERE s.category='ui_read_registry' AND
     (v.id IS NULL OR v.approved_at IS NULL OR s.cached_value IS DISTINCT FROM v.value)
 ) THEN RAISE EXCEPTION 'UI registry settings/version pointer is unmatched or unapproved'; END IF;
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
 AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved UI registry baseline missing'; END IF;
 FOR r IN SELECT s.scope_type,s.scope_id,s.cached_value FROM public.settings s
 WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE LOOP
   IF jsonb_typeof(r.cached_value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Malformed UI registry resources';
   END IF;
   resources:=r.cached_value->'resources';
   FOREACH resource_key IN ARRAY ARRAY['workflow_templates','workflow_template_steps'] LOOP
     SELECT count(*) INTO selected_count FROM jsonb_array_elements(resources) e WHERE e->>'key'=resource_key;
     IF selected_count>1 THEN RAISE EXCEPTION 'Duplicate workflow registry resource %',resource_key; END IF;
     IF selected_count=0 THEN CONTINUE; END IF;
     SELECT e INTO resource FROM jsonb_array_elements(resources) e WHERE e->>'key'=resource_key;
     IF resource->>'relation' IS DISTINCT FROM 'public.'||resource_key THEN CONTINUE; END IF;
     IF resource ? 'read_relation' AND resource->>'read_relation' IS DISTINCT FROM 'public.'||resource_key||'_read_v1' THEN
       RAISE EXCEPTION 'Workflow read relation requires explicit override review: %',resource_key;
     END IF;
     SELECT jsonb_agg(CASE WHEN e->>'key'=resource_key
       THEN e||jsonb_build_object('read_relation','public.'||resource_key||'_read_v1') ELSE e END ORDER BY n)
     INTO resources FROM jsonb_array_elements(resources) WITH ORDINALITY entries(e,n);
   END LOOP;
   next_value:=jsonb_set(r.cached_value,'{resources}',resources);
   IF next_value IS DISTINCT FROM r.cached_value THEN
     PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,
       next_value,active_schema.version,'Preserve workflow hierarchy-scoped UI reads');
   END IF;
 END LOOP;
END;
$registry$;
COMMIT;
