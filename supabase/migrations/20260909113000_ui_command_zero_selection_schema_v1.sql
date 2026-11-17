-- Preserve explicit zero-selection guards; correct only the versioned schema contract.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
DO $zero_selection$
DECLARE
 v_current public.schema_registry%ROWTYPE;
 v_version integer;
 r record;
 v_canonical jsonb;
 v_extended jsonb;
 v_selection jsonb;
 v_positive jsonb := '{"type":"integer","minimum":1}'::jsonb;
 v_max jsonb := $zero_max${"anyOf":[{"type":"integer","minimum":1},{"const":0}]}$zero_max$::jsonb;
 v_guard jsonb := $zero_guard$[{"if":{"required":["max_count"],"properties":{"max_count":{"const":0}}},"then":{"required":["mode"],"properties":{"mode":{"const":"none"}}}}]$zero_guard$::jsonb;
BEGIN
 LOCK TABLE public.schema_registry IN SHARE ROW EXCLUSIVE MODE;
 SELECT * INTO v_current FROM public.schema_registry
 WHERE category='ui_command_registry' AND is_active
 ORDER BY version DESC LIMIT 1 FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'Active command registry schema missing'; END IF;
 v_selection := v_current.schema #> '{properties,commands,items,properties,selection}';
 IF jsonb_typeof(v_selection) IS DISTINCT FROM 'object'
 OR v_selection->>'type' IS DISTINCT FROM 'object'
 OR v_selection ?| ARRAY['anyOf','oneOf','not','if','then','else']
 OR NOT ((
   (v_selection #> '{properties,max_count}' = v_positive AND NOT (v_selection ? 'allOf'))
   OR (v_selection #> '{properties,max_count}' = v_max AND v_selection->'allOf' = v_guard)
 ) IS TRUE) THEN
   RAISE EXCEPTION 'Unsupported command selection schema requires explicit review';
 END IF;
 -- Restore only this migration's two paths; preserve every unrelated active constraint.
 v_canonical := jsonb_set(v_current.schema,
   '{properties,commands,items,properties,selection}',
   jsonb_set(v_selection - 'allOf','{properties,max_count}',v_positive,false),false);
 v_extended := jsonb_set(v_canonical,
   '{properties,commands,items,properties,selection}',
   jsonb_set(v_selection - 'allOf','{properties,max_count}',v_max,false)
     || jsonb_build_object('allOf',v_guard),false);
 -- Compare schema payloads only, not mutable version/activation metadata.
 IF EXISTS(SELECT 1 FROM public.schema_registry
   WHERE category='ui_command_registry' AND is_active
     AND schema IS DISTINCT FROM v_canonical AND schema IS DISTINCT FROM v_extended)
 OR EXISTS(SELECT 1 FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
   LEFT JOIN public.schema_registry sr ON sr.category=s.category AND sr.version=sv.schema_version
   WHERE s.category='ui_command_registry'
     AND (sr.schema IS DISTINCT FROM v_canonical AND sr.schema IS DISTINCT FROM v_extended)) THEN
   RAISE EXCEPTION 'Custom command registry schema requires explicit zero-selection review';
 END IF;
 IF v_current.schema=v_extended THEN
   v_version:=v_current.version;
 ELSE
   SELECT COALESCE(MAX(version),0)+1 INTO v_version FROM public.schema_registry
     WHERE category='ui_command_registry';
   INSERT INTO public.schema_registry(category,version,schema,description,examples,is_active)
   VALUES('ui_command_registry',v_version,v_extended,
     'Permit max_count zero only with explicit selection mode none; preserve runtime guards',
     v_current.examples,true);
 END IF;
 UPDATE public.schema_registry SET is_active=false
 WHERE category='ui_command_registry' AND is_active AND version<>v_version;
 FOR r IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
   FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
   WHERE s.category='ui_command_registry' ORDER BY s.id FOR UPDATE OF s
 LOOP
   IF r.schema_version IS DISTINCT FROM v_version THEN
     PERFORM public.upsert_settings_value_v1('ui_command_registry',r.scope_type,r.scope_id,
       r.value,v_version,'Repoint unchanged command registry to explicit zero-selection schema');
   END IF;
 END LOOP;
END;
$zero_selection$;
COMMIT;
