BEGIN;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20260912203000_operation_template_scoped_read_v1'));
-- The predicate is evaluated from authenticated caller identity even inside a
-- definer reader. security_invoker alone does not enforce the provider boundary.
CREATE OR REPLACE VIEW public.operation_templates_read_v1 WITH (security_invoker=true) AS
SELECT ot.*
FROM public.operation_templates ot
WHERE COALESCE(auth.jwt()->>'role','')='service_role'
 OR (COALESCE(auth.jwt()->>'role','')='authenticated'
 AND public.user_has_resource_capability_v1('operation_templates','read')
 AND (public.is_platform_user() OR EXISTS (
   SELECT 1 FROM public.providers p
   WHERE p.id=ot.provider_id AND p.organization_id=public.current_user_org_id()
 )));
REVOKE ALL ON public.operation_templates_read_v1 FROM PUBLIC,anon,authenticated,service_role;
DO $owners$
DECLARE reader REGPROCEDURE;
BEGIN
 FOREACH reader IN ARRAY ARRAY[
 'public.ui_list_resource_v1(text,jsonb,integer,integer,jsonb)'::regprocedure,
 'public.ui_get_resource_v1(text,uuid)'::regprocedure,
 'public.ui_resource_metrics_v1(text,jsonb,text[])'::regprocedure,
 'public.ui_filter_distinct_values_v1(text,text,text,integer)'::regprocedure] LOOP
   IF (SELECT proowner FROM pg_proc WHERE oid=reader) IS DISTINCT FROM
      (SELECT relowner FROM pg_class WHERE oid='public.operation_templates_read_v1'::regclass) THEN
     RAISE EXCEPTION 'Resource reader/view ownership mismatch for %',reader;
   END IF;
 END LOOP;
END;
$owners$;

DO $registry$
DECLARE r RECORD; resource JSONB; resources JSONB; next_value JSONB; selected_count INT;
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
 ) THEN
   RAISE EXCEPTION 'UI registry settings/version pointer is unmatched or unapproved';
 END IF;
 PERFORM 1 FROM public.settings_versions WHERE category='ui_read_registry'
 AND effective_until IS NULL AND approved_at IS NOT NULL ORDER BY id FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Approved UI registry baseline missing'; END IF;
 FOR r IN SELECT s.scope_type,s.scope_id,s.cached_value,v.value,v.schema_version,v.approved_at
 FROM public.settings s JOIN public.settings_versions v
 ON v.id=s.settings_version_id AND v.scope_hash=s.scope_hash
 WHERE s.category='ui_read_registry' ORDER BY s.id FOR UPDATE OF s LOOP
   IF r.approved_at IS NULL OR r.cached_value IS DISTINCT FROM r.value THEN
     RAISE EXCEPTION 'UI registry cache lacks matching approved source';
   END IF;
   IF jsonb_typeof(r.cached_value->'resources') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Malformed UI registry resources';
   END IF;
   SELECT count(*) INTO selected_count FROM jsonb_array_elements(r.cached_value->'resources') e
   WHERE e->>'key'='operation_templates';
   IF selected_count>1 THEN RAISE EXCEPTION 'Duplicate operation template registry resource'; END IF;
   IF selected_count=0 THEN CONTINUE; END IF;
   SELECT e INTO resource FROM jsonb_array_elements(r.cached_value->'resources') e
   WHERE e->>'key'='operation_templates';
   -- Preserve owned relation overrides. Do not redefine writes or scope policy.
   IF resource->>'relation' IS DISTINCT FROM 'public.operation_templates' THEN CONTINUE; END IF;
   IF resource ? 'read_relation' AND resource->>'read_relation' IS DISTINCT FROM 'public.operation_templates_read_v1' THEN
     RAISE EXCEPTION 'Operation template read relation requires explicit override review';
   END IF;
   SELECT jsonb_agg(CASE WHEN e->>'key'='operation_templates'
     THEN e||jsonb_build_object('read_relation','public.operation_templates_read_v1')
     ELSE e END ORDER BY n) INTO resources
   FROM jsonb_array_elements(r.cached_value->'resources') WITH ORDINALITY entries(e,n);
   next_value:=jsonb_set(r.cached_value,'{resources}',resources);
   IF next_value IS DISTINCT FROM r.cached_value THEN
     PERFORM public.upsert_settings_value_v1('ui_read_registry',r.scope_type,r.scope_id,
       next_value,active_schema.version,'Preserve operation template provider-scoped UI reads');
   END IF;
 END LOOP;
END;
$registry$;
COMMIT;
