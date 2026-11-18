-- Translate the platform actor scope only at the workflow-template creation boundary.
BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SET LOCAL lock_timeout='10s';
SELECT pg_advisory_xact_lock(hashtext('20261019180000_workflow_template_platform_scope_v1'));

DO $platform_scope$
DECLARE
  target REGPROCEDURE := 'public.ui_create_workflow_template_v1(text,text,uuid)'::regprocedure;
  definition TEXT;
  seam TEXT := $seam$  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);$seam$;
  replacement TEXT := $replacement$  IF v_scope_type = 'platform' THEN
    v_scope_type := public.get_root_scope_type_key_v1();
    v_scope_id := NULL;
  END IF;

  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);$replacement$;
BEGIN
  definition := pg_get_functiondef(target);
  IF definition IS NULL OR cardinality(string_to_array(definition,seam))<>2
     OR definition LIKE '%get_root_scope_type_key_v1%' THEN
    RAISE EXCEPTION 'Workflow template platform scope requires one unmodified native capability seam: %',target;
  END IF;
  EXECUTE replace(definition,seam,replacement);
END;
$platform_scope$;
COMMIT;
