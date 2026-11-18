BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;

-- Nested jsonb_set paths cannot create missing workflow/delivery parents.
DO $activation_policy$
DECLARE
 fn REGPROCEDURE:='public.integration_plugin_activate_core_v1(uuid,text,uuid,text)'::regprocedure;
 body TEXT;
 prior TEXT:=$prior$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,enabled}', 'true'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{workflow,template_name}', to_jsonb(v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,mode}', '"accepted_async"'::jsonb, TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery,status_code}', '202'::jsonb, TRUE);$prior$;
 replacement TEXT:=$replacement$    v_route_policy := COALESCE(v_version.inbound_config #> '{route,policy}', '{}'::jsonb);
    v_route_policy := jsonb_set(v_route_policy, '{workflow}',
      COALESCE(v_route_policy->'workflow', '{}'::jsonb) || jsonb_build_object(
        'enabled', TRUE, 'template_name', v_workflow_template_name), TRUE);
    v_route_policy := jsonb_set(v_route_policy, '{delivery}',
      COALESCE(v_route_policy->'delivery', '{}'::jsonb) || jsonb_build_object(
        'mode', 'accepted_async', 'status_code', 202), TRUE);$replacement$;
BEGIN
 body:=pg_get_functiondef(fn);
 IF (length(body)-length(replace(body,prior,'')))/length(prior)<>1 THEN
  RAISE EXCEPTION 'Expected one unmodified integration plugin activation policy seam';
 END IF;
 EXECUTE replace(body,prior,replacement);
END;
$activation_policy$;
COMMIT;
