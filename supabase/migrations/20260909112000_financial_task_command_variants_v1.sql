-- Draft: expose only with the qualified backend and matching App integration.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
DO $variants$
DECLARE
 r record; next_value jsonb; item jsonb; existing jsonb;
 command_count integer; matched_count integer := 0;
 variant jsonb:=jsonb_build_object('normalization','financial_amount_v1',
   'title','Financial task completion','description','Record the amount using an authorized operational session. Settlement approval remains a separate workflow outcome.',
   'fields',jsonb_build_array(jsonb_build_object('key','amount','type','number','required',true,'label','Amount')));
BEGIN
 FOR r IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
   FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
   WHERE s.category='ui_command_registry'
   ORDER BY s.id FOR UPDATE OF s
 LOOP
   IF jsonb_typeof(r.value->'commands') IS DISTINCT FROM 'array' THEN
     RAISE EXCEPTION 'Financial command registry shape invalid';
   END IF;
   SELECT count(*) INTO command_count FROM jsonb_array_elements(r.value->'commands') e
     WHERE e->>'key'='tasks.complete';
   IF command_count > 1 THEN RAISE EXCEPTION 'Duplicate tasks.complete command'; END IF;
   -- A scoped commands array without this command retains its existing selection.
   IF command_count=0 THEN CONTINUE; END IF;
   matched_count:=matched_count+1;
   SELECT value INTO item FROM jsonb_array_elements(r.value->'commands')
     WHERE value->>'key'='tasks.complete';
   IF jsonb_typeof(item#>'{execution,input_schema}') IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'Financial command input schema absent';
   END IF;
   existing:=item#>'{execution,input_schema,task_type_overrides}';
   IF existing IS NOT NULL AND jsonb_typeof(existing) IS DISTINCT FROM 'object' THEN
     RAISE EXCEPTION 'Financial task overrides invalid';
   END IF;
   IF (existing ? 'cod_cash_handover' AND existing->'cod_cash_handover' IS DISTINCT FROM variant)
      OR (existing ? 'cod_cashier_count' AND existing->'cod_cashier_count' IS DISTINCT FROM variant) THEN
     RAISE EXCEPTION 'Financial task override conflict';
   END IF;
   SELECT jsonb_set(r.value,'{commands}',jsonb_agg(CASE WHEN entry->>'key'='tasks.complete' THEN
     jsonb_set(entry,'{execution,input_schema,task_type_overrides}',
       COALESCE(entry#>'{execution,input_schema,task_type_overrides}','{}'::jsonb)||
       jsonb_build_object('cod_cash_handover',variant,'cod_cashier_count',variant),true)
     ELSE entry END ORDER BY ordinal)) INTO next_value
   FROM jsonb_array_elements(r.value->'commands') WITH ORDINALITY x(entry,ordinal);
   IF next_value IS DISTINCT FROM r.value THEN
     PERFORM public.upsert_settings_value_v1('ui_command_registry',r.scope_type,r.scope_id,
       next_value,r.schema_version,'Configure qualified COD task amount inputs');
   END IF;
 END LOOP;
 IF matched_count=0 THEN RAISE EXCEPTION 'No tasks.complete registry command found'; END IF;
END;
$variants$;
COMMIT;
