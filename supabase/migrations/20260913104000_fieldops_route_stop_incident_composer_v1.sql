DO $registry$
DECLARE
  r RECORD;
  v_commands JSONB;
  v_next JSONB;
BEGIN
  FOR r IN SELECT s.scope_type,s.scope_id,sv.value,sv.schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='ui_command_registry'
  LOOP
    v_commands:=r.value->'commands';
    IF jsonb_typeof(v_commands) IS DISTINCT FROM 'array'
      OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_commands) c WHERE c->>'key'='tasks.report_incident') THEN
      RAISE EXCEPTION 'route_stop_incident_registry_missing' USING ERRCODE='23514';
    END IF;
    SELECT jsonb_agg(
      CASE WHEN c.value->>'key'='tasks.report_incident' THEN
        c.value||jsonb_build_object('execution',
          (COALESCE(c.value->'execution','{}'::jsonb)-'idempotency')||jsonb_build_object(
            'input_schema',jsonb_build_object(
              'version',1,'title','Report route-stop incident',
              'description','Describe the incident and capture at least one proof photo before reporting.',
              'fields',jsonb_build_array(
                jsonb_build_object('key','incident_type','label','Incident type','type','lookup',
                  'lookup_category','route_stop_incident_type','required',TRUE),
                jsonb_build_object('key','summary','label','Summary','type','textarea','required',TRUE))),
            'evidence',jsonb_build_object(
              'context','task','registration_rpc','register_mobile_artifact_v1',
              'bucket','fieldops-evidence','min_items',1,'max_items',6)))
      ELSE c.value END ORDER BY c.ord)
    INTO v_next FROM jsonb_array_elements(v_commands) WITH ORDINALITY AS c(value,ord);
    IF v_next IS DISTINCT FROM v_commands THEN
      PERFORM public.upsert_settings_value_v1(
        'ui_command_registry',r.scope_type,r.scope_id,
        jsonb_set(r.value,'{commands}',v_next),r.schema_version,
        'Complete FieldOps route-stop incident composer contract');
    END IF;
  END LOOP;
END;
$registry$;
