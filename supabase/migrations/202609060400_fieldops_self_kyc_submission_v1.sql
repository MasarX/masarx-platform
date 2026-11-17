-- Self-service evidence uses canonical fleet and compliance records, never approval authority.
BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('202609060400_fieldops_self_kyc_submission_v1'));

CREATE OR REPLACE FUNCTION public.ui_assert_generic_mutation_relation_v1(p_relation REGCLASS)
RETURNS VOID LANGUAGE plpgsql STABLE SET search_path TO public, pg_temp AS $fn$
BEGIN
 IF p_relation IS NULL THEN
  RAISE EXCEPTION 'Generic resource mutation requires a resolved relation' USING ERRCODE='22023';
 END IF;
 IF p_relation='public.workflow_run_triggers'::regclass THEN
  RAISE EXCEPTION 'Workflow run trigger mutations require dedicated lifecycle RPCs' USING ERRCODE='42501';
 END IF;
 IF p_relation='public.driver_compliance_events'::regclass THEN
  RAISE EXCEPTION 'Compliance events require dedicated append-only RPCs' USING ERRCODE='42501';
 END IF;
END;
$fn$;
REVOKE ALL ON FUNCTION public.ui_assert_generic_mutation_relation_v1(REGCLASS) FROM PUBLIC,anon,authenticated,service_role;

CREATE UNIQUE INDEX driver_compliance_self_retry_v1 ON public.driver_compliance_events
 (organization_id,user_id,(payload->>'retry_key'))
 WHERE actor_system='fieldops_self_kyc' AND payload ? 'retry_key';

CREATE OR REPLACE FUNCTION public.assert_self_kyc_actor_v1()
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE v_actor UUID:=auth.uid(); v_org UUID:=public.current_user_org_id();
BEGIN
 IF v_actor IS NULL OR v_org IS NULL OR NOT public.user_has_capability_v1('kyc.write',public.current_user_scope_type(),COALESCE(public.current_user_scope_id(),v_org)) THEN
  RAISE EXCEPTION 'self_kyc_forbidden' USING ERRCODE='42501';
 END IF;
 -- One actor lock serializes receipts/registration ownership before storage object locks.
 PERFORM 1 FROM public.users WHERE id=v_actor AND organization_id=v_org FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'self_kyc_forbidden' USING ERRCODE='42501'; END IF;
 RETURN v_org;
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_self_kyc_actor_v1() FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.assert_self_kyc_object_v1(p_bucket TEXT,p_key TEXT)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE v_org UUID:=public.current_user_org_id(); v_metadata JSONB;
BEGIN
 IF p_bucket IS DISTINCT FROM 'fieldops-evidence' OR p_key IS NULL
    OR left(p_key,length(v_org::text)+1) IS DISTINCT FROM v_org::text||'/' THEN
  RAISE EXCEPTION 'self_kyc_evidence_forbidden' USING ERRCODE='42501';
 END IF;
 SELECT o.metadata INTO v_metadata FROM storage.objects o
 WHERE o.bucket_id=p_bucket AND o.name=p_key AND o.owner=auth.uid() FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'self_kyc_evidence_forbidden' USING ERRCODE='42501'; END IF;
 RETURN COALESCE(v_metadata,'{}'::jsonb);
END;
$fn$;
REVOKE ALL ON FUNCTION public.assert_self_kyc_object_v1(TEXT,TEXT) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.register_self_kyc_artifact_v1(p_artifact JSONB)
RETURNS TABLE(artifact_id UUID) LANGUAGE plpgsql SECURITY DEFINER
SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE v_org UUID:=public.assert_self_kyc_actor_v1(); v_meta JSONB; v_id UUID;
BEGIN
 IF jsonb_typeof(p_artifact) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'self_kyc_invalid_evidence' USING ERRCODE='22023';
 END IF;
 IF (p_artifact ? 'organization_id' AND p_artifact->>'organization_id' IS DISTINCT FROM v_org::text)
 OR (p_artifact ? 'user_id' AND p_artifact->>'user_id' IS DISTINCT FROM auth.uid()::text) THEN
  RAISE EXCEPTION 'self_kyc_forbidden' USING ERRCODE='42501';
 END IF;
 v_meta:=public.assert_self_kyc_object_v1(p_artifact->>'storage_bucket',p_artifact->>'storage_key');
 SELECT r.artifact_id INTO v_id FROM public.register_artifact_v1(jsonb_build_object(
  'organization_id',v_org,'storage_bucket',p_artifact->>'storage_bucket','storage_key',p_artifact->>'storage_key',
  'created_by_user_id',auth.uid(),'source_system','fieldops_self_kyc',
  'mime_type',v_meta->>'mimetype','size_bytes',v_meta->'size',
  'metadata',jsonb_build_object('subject_user_id',auth.uid(),'source','fieldops_self_kyc'))) r;
 RETURN QUERY SELECT v_id;
END;
$fn$;
REVOKE ALL ON FUNCTION public.register_self_kyc_artifact_v1(JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.register_self_kyc_artifact_v1(JSONB) TO authenticated;
CREATE OR REPLACE FUNCTION api.register_self_kyc_artifact_v1(p_artifact JSONB)
RETURNS TABLE(artifact_id UUID) LANGUAGE sql SECURITY INVOKER SET search_path TO public,api,pg_temp
AS $fn$ SELECT * FROM public.register_self_kyc_artifact_v1(p_artifact); $fn$;
REVOKE ALL ON FUNCTION api.register_self_kyc_artifact_v1(JSONB) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.register_self_kyc_artifact_v1(JSONB) TO authenticated;

CREATE OR REPLACE FUNCTION public.submit_self_kyc_v1(
 p_category TEXT,p_payload JSONB,p_idempotency_key TEXT,p_expected_actor_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE
 v_org UUID:=public.assert_self_kyc_actor_v1(); v_actor UUID:=auth.uid();
 v_payload JSONB:=COALESCE(p_payload,'{}'::jsonb); v_hash TEXT; v_previous public.driver_compliance_events%ROWTYPE;
 v_event UUID:=gen_random_uuid(); v_document UUID; v_vehicle UUID; v_result JSONB;
 v_evidence JSONB:=COALESCE(p_payload->'evidence','{}'::jsonb); v_pair RECORD; v_artifact public.artifacts%ROWTYPE;
 v_doc_type TEXT; v_year TEXT; v_item TEXT;
BEGIN
 IF p_expected_actor_user_id IS DISTINCT FROM v_actor THEN
  RAISE EXCEPTION 'self_kyc_actor_changed' USING ERRCODE='42501';
 END IF;
 IF p_category NOT IN ('document','vehicle_registration','vehicle_photos','cleaning','pre_shift')
 OR p_category IS NULL OR p_idempotency_key IS NULL OR length(p_idempotency_key) NOT BETWEEN 1 AND 200
 OR jsonb_typeof(v_payload) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'self_kyc_invalid_submission' USING ERRCODE='22023';
 END IF;
 -- No caller-controlled approval, subject, result, lineage, or arbitrary metadata.
 IF EXISTS (SELECT 1 FROM jsonb_object_keys(v_payload) k WHERE k NOT IN
 ('doc_type','plate','vin','year','model','checked_item_ids','shift_id','health_ok','vehicle_id','evidence','note','angle')) THEN
  RAISE EXCEPTION 'self_kyc_reserved_field' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(v_payload) e WHERE e.key IN
 ('doc_type','plate','vin','year','model','shift_id','vehicle_id','note','angle') AND jsonb_typeof(e.value)<>'string') THEN
  RAISE EXCEPTION 'self_kyc_text_required' USING ERRCODE='22023';
 END IF;
 v_hash:=encode(extensions.digest(convert_to(jsonb_build_object('category',p_category,'payload',v_payload)::text,'UTF8'),'sha256'),'hex');
 SELECT * INTO v_previous FROM public.driver_compliance_events
 WHERE organization_id=v_org AND user_id=v_actor AND actor_system='fieldops_self_kyc'
 AND payload->>'retry_key'=p_idempotency_key;
 IF FOUND THEN
  IF v_previous.payload->>'request_hash' IS DISTINCT FROM v_hash THEN
   RAISE EXCEPTION 'self_kyc_retry_conflict' USING ERRCODE='23505';
  END IF;
  RETURN v_previous.payload->'result';
 END IF;
 IF jsonb_typeof(v_evidence) IS DISTINCT FROM 'object' THEN
  RAISE EXCEPTION 'self_kyc_invalid_evidence' USING ERRCODE='22023';
 END IF;
 IF p_category IN ('document','vehicle_registration','cleaning') AND
 (NOT (v_evidence ? 'document') OR (SELECT count(*) FROM jsonb_object_keys(v_evidence))<>1) THEN
  RAISE EXCEPTION 'self_kyc_document_evidence_required' USING ERRCODE='22023';
 END IF;
 IF EXISTS(SELECT 1 FROM jsonb_each(v_evidence) e WHERE jsonb_typeof(e.value)<>'string') THEN
  RAISE EXCEPTION 'self_kyc_invalid_evidence' USING ERRCODE='22023';
 END IF;
 FOR v_pair IN SELECT key,value FROM jsonb_each_text(v_evidence) ORDER BY value,key LOOP
  IF length(btrim(v_pair.key)) NOT BETWEEN 1 AND 100 THEN
   RAISE EXCEPTION 'self_kyc_invalid_evidence' USING ERRCODE='22023';
  END IF;
  SELECT * INTO v_artifact FROM public.artifacts WHERE id=v_pair.value::uuid AND organization_id=v_org;
  IF NOT FOUND THEN RAISE EXCEPTION 'self_kyc_evidence_forbidden' USING ERRCODE='42501'; END IF;
  PERFORM public.assert_self_kyc_object_v1(v_artifact.storage_bucket,v_artifact.storage_key);
 END LOOP;
 IF p_category='vehicle_photos' AND v_evidence='{}'::jsonb THEN
  RAISE EXCEPTION 'self_kyc_photo_angles_required' USING ERRCODE='22023';
 END IF;
 IF p_category<>'vehicle_registration' AND NULLIF(v_payload->>'vehicle_id','') IS NOT NULL THEN
  v_vehicle:=(v_payload->>'vehicle_id')::uuid;
  PERFORM 1 FROM public.vehicles v WHERE v.id=v_vehicle AND v.organization_id=v_org FOR UPDATE;
  IF NOT FOUND OR NOT (
   EXISTS(SELECT 1 FROM public.vehicle_assignments a WHERE a.vehicle_id=v_vehicle AND a.organization_id=v_org
    AND a.assigned_to_user_id=v_actor AND a.status='active' AND a.ended_at IS NULL AND a.started_at<=now())
   OR EXISTS(SELECT 1 FROM public.driver_compliance_events e WHERE e.organization_id=v_org AND e.user_id=v_actor
    AND e.actor_system='fieldops_self_kyc' AND e.event_type='self_kyc_vehicle_registration'
    AND e.payload#>>'{result,vehicle_id}'=v_vehicle::text)
  ) THEN RAISE EXCEPTION 'self_kyc_vehicle_forbidden' USING ERRCODE='42501'; END IF;
 END IF;
 IF p_category='document' THEN
  SELECT value INTO v_doc_type FROM public.lookup_values lv JOIN public.lookup_definitions ld ON ld.id=lv.lookup_definition_id
  WHERE ld.category='self_kyc_document_type' AND lv.value=v_payload->>'doc_type' AND lv.status='active' LIMIT 1;
  IF v_doc_type IS NULL THEN RAISE EXCEPTION 'self_kyc_document_type_required' USING ERRCODE='22023'; END IF;
  INSERT INTO public.driver_documents(organization_id,user_id,doc_type,status,artifact_id,metadata)
  VALUES(v_org,v_actor,v_doc_type,'submitted',(v_evidence->>'document')::uuid,jsonb_build_object('submission_event_id',v_event))
  RETURNING id INTO v_document;
 ELSIF p_category='vehicle_registration' THEN
  v_year:=v_payload->>'year';
  IF length(btrim(COALESCE(v_payload->>'plate','')))<5 OR length(btrim(COALESCE(v_payload->>'vin','')))<8
  OR v_year IS NULL OR v_year !~ '^[0-9]{4}$' OR length(btrim(COALESCE(v_payload->>'model','')))=0
  OR v_payload ? 'vehicle_id' THEN
   RAISE EXCEPTION 'self_kyc_registration_fields_required' USING ERRCODE='22023';
  END IF;
  -- Preserve four-digit source year in the event, including 0000; obey canonical fleet constraint.
  INSERT INTO public.vehicles(organization_id,plate_number,vin,model,model_year,status,is_active)
  VALUES(v_org,btrim(v_payload->>'plate'),btrim(v_payload->>'vin'),btrim(v_payload->>'model'),
   CASE WHEN v_year::int>=1900 THEN v_year::int END,'submitted',FALSE) RETURNING id INTO v_vehicle;
 ELSIF p_category='cleaning' THEN
  IF jsonb_typeof(v_payload->'checked_item_ids') IS DISTINCT FROM 'array' THEN
   RAISE EXCEPTION 'self_kyc_checklist_required' USING ERRCODE='22023';
  END IF;
  IF jsonb_array_length(v_payload->'checked_item_ids')=0 THEN
   RAISE EXCEPTION 'self_kyc_checklist_required' USING ERRCODE='22023';
  END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(v_payload->'checked_item_ids') e WHERE jsonb_typeof(e)<>'string') THEN
   RAISE EXCEPTION 'self_kyc_checklist_required' USING ERRCODE='22023';
  END IF;
  FOR v_item IN SELECT jsonb_array_elements_text(v_payload->'checked_item_ids') LOOP
   IF v_item IS NULL OR btrim(v_item)='' THEN RAISE EXCEPTION 'self_kyc_checklist_required' USING ERRCODE='22023'; END IF;
  END LOOP;
 ELSIF p_category='pre_shift' THEN
  IF btrim(COALESCE(v_payload->>'shift_id',''))='' OR jsonb_typeof(v_payload->'health_ok') IS DISTINCT FROM 'boolean' THEN
   RAISE EXCEPTION 'self_kyc_preshift_fields_required' USING ERRCODE='22023';
  END IF;
 END IF;
 v_result:=jsonb_strip_nulls(jsonb_build_object('ok',TRUE,'status','submitted','submission_id',v_event,
  'document_id',v_document,'vehicle_id',v_vehicle,'category',p_category));
 INSERT INTO public.driver_compliance_events(id,organization_id,user_id,event_type,actor_user_id,actor_system,payload)
 VALUES(v_event,v_org,v_actor,'self_kyc_'||p_category,v_actor,'fieldops_self_kyc',
  jsonb_build_object('retry_key',p_idempotency_key,'request_hash',v_hash,'submission',v_payload,'result',v_result));
 RETURN v_result;
END;
$fn$;
REVOKE ALL ON FUNCTION public.submit_self_kyc_v1(TEXT,JSONB,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.submit_self_kyc_v1(TEXT,JSONB,TEXT,UUID) TO authenticated;

CREATE OR REPLACE FUNCTION public.ui_execute_self_kyc_v1(
 p_action_key TEXT,p_resource_key TEXT,p_selection_ids UUID[],p_selection_id UUID,p_selection_count INT,
 p_params JSONB,p_idempotency_key TEXT,p_expected_actor_user_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path TO public,extensions,pg_temp AS $fn$
DECLARE v_category TEXT:=p_params->>'category'; v_payload JSONB:=p_params->'payload';
BEGIN
 IF p_resource_key IS DISTINCT FROM 'driver_self_kyc' OR p_action_key IS DISTINCT FROM 'driver_self_kyc.'||v_category
 OR p_selection_id IS NOT NULL OR COALESCE(cardinality(p_selection_ids),0)<>0 OR COALESCE(p_selection_count,0)<>0 THEN
  RAISE EXCEPTION 'self_kyc_invalid_command' USING ERRCODE='22023';
 END IF;
 RETURN public.submit_self_kyc_v1(v_category,v_payload,p_idempotency_key,p_expected_actor_user_id);
END;
$fn$;
REVOKE ALL ON FUNCTION public.ui_execute_self_kyc_v1(TEXT,TEXT,UUID[],UUID,INT,JSONB,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.ui_execute_self_kyc_v1(TEXT,TEXT,UUID[],UUID,INT,JSONB,TEXT,UUID) TO authenticated;
CREATE OR REPLACE FUNCTION api.ui_execute_self_kyc_v1(
 p_action_key TEXT,p_resource_key TEXT,p_selection_ids UUID[],p_selection_id UUID,p_selection_count INT,
 p_params JSONB,p_idempotency_key TEXT,p_expected_actor_user_id UUID)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER SET search_path TO public,api,pg_temp AS $fn$
 SELECT public.ui_execute_self_kyc_v1(p_action_key,p_resource_key,p_selection_ids,p_selection_id,p_selection_count,
 p_params,p_idempotency_key,p_expected_actor_user_id);
$fn$;
REVOKE ALL ON FUNCTION api.ui_execute_self_kyc_v1(TEXT,TEXT,UUID[],UUID,INT,JSONB,TEXT,UUID) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION api.ui_execute_self_kyc_v1(TEXT,TEXT,UUID[],UUID,INT,JSONB,TEXT,UUID) TO authenticated;

CREATE VIEW public.driver_self_kyc WITH (security_invoker=TRUE) AS
SELECT id,organization_id,user_id,event_type,created_at,
 payload->'result' AS result, payload->'submission' AS submission
FROM public.driver_compliance_events
WHERE user_id=auth.uid() AND organization_id=public.current_user_org_id() AND actor_system='fieldops_self_kyc';
CREATE VIEW api.driver_self_kyc WITH (security_invoker=TRUE) AS SELECT * FROM public.driver_self_kyc;
GRANT SELECT ON public.driver_self_kyc,api.driver_self_kyc TO authenticated;

-- Versioned configuration additions preserve every unrelated row and scoped override.
DO $seed$
DECLARE v_row RECORD; v_value JSONB; v_roles JSONB; v_role JSONB; v_caps JSONB;
 v_commands JSONB:='[]'::jsonb; v_command JSONB; v_category TEXT; v_fields JSONB; v_evidence JSONB;
 v_resources JSONB; v_sections JSONB; v_existing JSONB; v_definition UUID;
BEGIN
 INSERT INTO public.lookup_definitions(category,description)
 VALUES('self_kyc_document_type','Applicant-supplied driver document categories')
 ON CONFLICT(category) DO NOTHING;
 SELECT id INTO v_definition FROM public.lookup_definitions WHERE category='self_kyc_document_type';
 INSERT INTO public.lookup_values(lookup_definition_id,value,label,status,sort_order)
 VALUES(v_definition,'iddoc','Identity document','active',10),
 (v_definition,'licensedoc','Driving licence','active',20),(v_definition,'iqamadoc','Iqama document','active',30)
 ON CONFLICT(lookup_definition_id,value) DO NOTHING;
 INSERT INTO public.lookup_definitions(category,description)
 VALUES('self_kyc_health','Self-attestation, not clearance')
 ON CONFLICT(category) DO NOTHING;
 SELECT id INTO v_definition FROM public.lookup_definitions WHERE category='self_kyc_health';
 INSERT INTO public.lookup_values(lookup_definition_id,value,label,status,sort_order)
 VALUES(v_definition,'true','I feel fit','active',10),(v_definition,'false','I do not feel fit','active',20)
 ON CONFLICT(lookup_definition_id,value) DO NOTHING;

 FOR v_row IN SELECT s.scope_type,s.scope_id,sv.value FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='access_control_policy' LOOP
  v_value:=v_row.value; v_roles:='[]'::jsonb;
  v_caps:=COALESCE(v_value->'capabilities','[]'::jsonb);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_caps) x WHERE x->>'key'='kyc.write') THEN
   v_caps:=v_caps||jsonb_build_array(jsonb_build_object('key','kyc.write','label','Submit own KYC evidence'));
  END IF;
  FOR v_role IN SELECT value FROM jsonb_array_elements(COALESCE(v_value->'roles','[]'::jsonb)) LOOP
   IF v_role->>'key' IN ('driver','ops_admin') AND NOT COALESCE(v_role->'capability_keys','[]'::jsonb) ?| ARRAY['*','kyc.write'] THEN
    v_role:=jsonb_set(v_role,'{capability_keys}',COALESCE(v_role->'capability_keys','[]'::jsonb)||'["kyc.write"]'::jsonb);
   END IF;
   v_roles:=v_roles||jsonb_build_array(v_role);
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_roles) r WHERE r->>'key'='driver') THEN
   v_roles:=v_roles||'[{"key":"driver","label":"Driver","capability_keys":["kyc.write"]}]'::jsonb;
  END IF;
  v_value:=jsonb_set(jsonb_set(v_value,'{capabilities}',v_caps),'{roles}',v_roles);
  IF NOT COALESCE(v_value#>'{assignments,user_type}','{}'::jsonb) ? 'driver' THEN
   v_value:=jsonb_set(v_value,'{assignments}',COALESCE(v_value->'assignments','{}'::jsonb)||
    jsonb_build_object('user_type',COALESCE(v_value#>'{assignments,user_type}','{}'::jsonb)||'{"driver":["driver"]}'::jsonb));
  END IF;
  IF v_value IS DISTINCT FROM v_row.value THEN
   PERFORM public.upsert_settings_value_v1('access_control_policy',v_row.scope_type,v_row.scope_id,v_value,1,'Preserve self KYC capability',NULL);
  END IF;
 END LOOP;
 FOREACH v_category IN ARRAY ARRAY['document','vehicle_registration','vehicle_photos','cleaning','pre_shift'] LOOP
  v_evidence:=jsonb_build_object('context','self','registration_rpc','register_self_kyc_artifact_v1',
   'bucket','fieldops-evidence','min_items',1,'max_items',1);
  IF v_category='document' THEN
   v_fields:='[{"key":"doc_type","label":"Document type","type":"lookup","lookup_category":"self_kyc_document_type","required":true}]'::jsonb;
  ELSIF v_category='vehicle_registration' THEN
   v_fields:='[{"key":"plate","label":"Plate","required":true},{"key":"vin","label":"VIN","required":true},{"key":"year","label":"Year (four digits)","required":true},{"key":"model","label":"Model","required":true}]'::jsonb;
  ELSIF v_category='vehicle_photos' THEN
   v_fields:='[{"key":"angle","label":"Photo angle name","required":true}]'::jsonb;
   v_evidence:=v_evidence||'{"max_items":20,"tag_field":"angle"}'::jsonb;
  ELSIF v_category='cleaning' THEN
   v_fields:='[{"key":"checked_item_ids","label":"Checked item IDs (comma separated)","required":true}]'::jsonb;
  ELSE
   v_fields:='[{"key":"shift_id","label":"Shift reference","required":true},{"key":"health_ok","label":"Health attestation","type":"lookup","lookup_category":"self_kyc_health","required":true}]'::jsonb;
   v_evidence:=NULL;
  END IF;
  v_fields:=v_fields||'[{"key":"note","label":"Note","type":"textarea","required":false}]'::jsonb;
  v_command:=jsonb_build_object('key','driver_self_kyc.'||v_category,'label',replace(v_category,'_',' '),
   'schema_category','resource:driver_self_kyc','capability','kyc.write',
   'selection',jsonb_build_object('mode','none','max_count',0),
   'execution',jsonb_strip_nulls(jsonb_build_object('type','rpc','rpc','ui_execute_self_kyc_v1',
    'idempotency','actor_retry_v1','params',jsonb_build_object('category',v_category),'payload_key','payload',
    'evidence',v_evidence,'input_schema',jsonb_build_object('version',1,'normalization','self_kyc_v1','fields',v_fields))));
  v_commands:=v_commands||jsonb_build_array(v_command);
 END LOOP;
 FOR v_row IN SELECT s.scope_type,s.scope_id,sv.value FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_command_registry' LOOP
  v_value:=v_row.value; v_existing:=COALESCE(v_value->'commands','[]'::jsonb);
  FOR v_command IN SELECT value FROM jsonb_array_elements(v_commands) LOOP
   IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_existing) c WHERE c->>'key'=v_command->>'key') THEN
    v_existing:=v_existing||jsonb_build_array(v_command);
   END IF;
  END LOOP;
  PERFORM public.upsert_settings_value_v1('ui_command_registry',v_row.scope_type,v_row.scope_id,
   jsonb_set(v_value,'{commands}',v_existing),1,'Self KYC current composer commands',NULL);
 END LOOP;
 FOR v_row IN SELECT s.scope_type,s.scope_id,sv.value FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_read_registry' LOOP
  v_resources:=COALESCE(v_row.value->'resources','[]'::jsonb);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_resources) r WHERE r->>'key'='driver_self_kyc') THEN
   v_resources:=v_resources||jsonb_build_array(jsonb_build_object('key','driver_self_kyc','label','My KYC submissions',
    'relation','public.driver_self_kyc','id_column','id','scope_columns',jsonb_build_object('tenant','organization_id'),
    'capability_read','kyc.write','select',jsonb_build_array('id','organization_id','user_id','event_type','created_at','result','submission'),
    'default_sort',jsonb_build_object('column','created_at','direction','desc')));
   PERFORM public.upsert_settings_value_v1('ui_read_registry',v_row.scope_type,v_row.scope_id,
    jsonb_set(v_row.value,'{resources}',v_resources),1,'Self-scoped immutable KYC readback',NULL);
  END IF;
 END LOOP;
 FOR v_row IN SELECT s.scope_type,s.scope_id,sv.value FROM public.settings s
 JOIN public.settings_versions sv ON sv.id=s.settings_version_id WHERE s.category='ui_navigation' LOOP
  v_value:=v_row.value; v_sections:=COALESCE(v_value#>'{apps,mobile,sections}','[]'::jsonb);
  IF NOT EXISTS(SELECT 1 FROM jsonb_array_elements(v_sections) s WHERE s->>'id'='self_kyc') THEN
   v_sections:=v_sections||'[{"id":"self_kyc","label":"My KYC","items":[{"id":"mobile-self-kyc","label":"My KYC submissions","resource":"driver_self_kyc","href":"/resources/driver_self_kyc","capability":"kyc.write"}]}]'::jsonb;
   v_value:=jsonb_set(v_value,'{apps}',COALESCE(v_value->'apps','{}'::jsonb)||
    jsonb_build_object('mobile',COALESCE(v_value#>'{apps,mobile}','{}'::jsonb)||jsonb_build_object('sections',v_sections)));
   PERFORM public.upsert_settings_value_v1('ui_navigation',v_row.scope_type,v_row.scope_id,v_value,1,'Current FieldOps self KYC entry point',NULL);
  END IF;
 END LOOP;
END;
$seed$;
COMMIT;
