-- Native contract proof only: this does not claim browser map or dataset fallback proof.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public,pgtap,extensions,pg_temp;
SELECT plan(60);
SELECT ok(public.ui_read_registry_route_stops_resource_v1()->'select' ?& ARRAY['planned_window_start_at','planned_window_end_at','destination_address'],'canonical route-stop seed selects actual planned-window fields and destination address');
SELECT ok(NOT (public.ui_read_registry_route_stops_resource_v1()->'select' ?| ARRAY['planned_start_at','planned_end_at']),'canonical route-stop seed does not reintroduce stale field names');

CREATE FUNCTION pg_temp.f808_projection_matrix() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
 own_org UUID:=gen_random_uuid(); foreign_org UUID:=gen_random_uuid();
 own_client UUID:=gen_random_uuid(); sibling_client UUID:=gen_random_uuid(); foreign_client UUID:=gen_random_uuid();
 own_sender UUID:=gen_random_uuid(); other_sender UUID:=gen_random_uuid();
 tenant_actor UUID:=gen_random_uuid(); client_actor UUID:=gen_random_uuid(); sender_actor UUID:=gen_random_uuid();
 address_one UUID:=gen_random_uuid(); address_two UUID:=gen_random_uuid(); address_null UUID:=gen_random_uuid();
 geocode_one UUID:=gen_random_uuid(); geocode_two UUID:=gen_random_uuid();
 own_shipment UUID:=gen_random_uuid(); other_shipment UUID:=gen_random_uuid();
 registry JSONB; access_policy JSONB; overridden JSONB; result JSONB; row_value JSONB;
 registry_version INT; access_version INT; entry JSONB; identity UUID; scope_kind TEXT; scope_id UUID;
BEGIN
 INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
  (own_org,'F808 owned','f808-'||own_org,'active'),(foreign_org,'F808 foreign','f808-'||foreign_org,'active');
 INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
  (own_client,own_org,'F808 client','f808-'||own_client,'active'),
  (sibling_client,own_org,'F808 sibling','f808-'||sibling_client,'active'),
  (foreign_client,foreign_org,'F808 foreign','f808-'||foreign_client,'active');
 INSERT INTO public.senders(id,client_id,name,status) VALUES
  (own_sender,own_client,'F808 sender','active'),(other_sender,own_client,'F808 other sender','active');
 INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id) VALUES
  (tenant_actor,own_org,'f808-'||tenant_actor||'@example.test','F808 tenant','ops_admin','active','tenant',NULL),
  (client_actor,own_org,'f808-'||client_actor||'@example.test','F808 client','ops_admin','active','client',own_client),
  (sender_actor,own_org,'f808-'||sender_actor||'@example.test','F808 sender','ops_admin','active','sender',own_sender);
 SELECT sv.value,sv.schema_version INTO STRICT registry,registry_version
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='ui_read_registry' AND s.scope_type='global' AND s.scope_id IS NULL;
 SELECT sv.value,sv.schema_version INTO STRICT access_policy,access_version
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='access_control_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
 -- Preserve the schema-valid role model; only the owned fixture's existing role grants change.
 SELECT jsonb_set(access_policy,'{roles}',jsonb_agg(CASE WHEN e->>'key'='ops_admin'
  THEN jsonb_set(e,'{capability_keys}','["addresses.read","shipments.read"]'::jsonb) ELSE e END ORDER BY n))
  INTO access_policy FROM jsonb_array_elements(access_policy->'roles') WITH ORDINALITY x(e,n);
 FOR scope_kind,scope_id IN SELECT * FROM (VALUES ('tenant',own_org),('client',own_client),('sender',own_sender)) x(kind,id) LOOP
  PERFORM public.upsert_settings_value_v1('access_control_policy',scope_kind,scope_id,access_policy,access_version,'F808 rollback capability fixture');
  PERFORM public.upsert_settings_value_v1('ui_read_registry',scope_kind,scope_id,registry,registry_version,'F808 rollback registry fixture');
 END LOOP;
 INSERT INTO public.addresses(id,organization_id,client_id,raw_input,line1,city,province,country,validation_status,district,coordinates) VALUES
  (address_one,own_org,own_client,'F808 PRIVATE RAW','private line','Riyadh','Riyadh','SA','pending','North',ST_SetSRID(ST_MakePoint(46.7,24.7),4326)::geography),
  (address_two,own_org,own_client,'F808 PRIVATE RAW','private line','Jeddah','Makkah','SA','pending',NULL,ST_SetSRID(ST_MakePoint(39.2,21.5),4326)::geography),
  (address_null,own_org,own_client,'F808 PRIVATE RAW','private line','Dammam','Eastern','SA','pending',NULL,NULL),
  (address_one,own_org,sibling_client,'F808 PRIVATE RAW','private line','Sibling city','Riyadh','SA','pending',NULL,ST_SetSRID(ST_MakePoint(47,25),4326)::geography),
  (address_one,foreign_org,foreign_client,'F808 PRIVATE RAW','private line','Foreign city','Riyadh','SA','pending',NULL,ST_SetSRID(ST_MakePoint(48,26),4326)::geography);
 INSERT INTO public.geocodes(id,address_id,organization_id,client_id,provider_name,coordinates,is_primary,expires_at,formatted_address,metadata) VALUES
  (geocode_one,address_one,own_org,own_client,'manual',ST_SetSRID(ST_MakePoint(46.7,24.7),4326)::geography,TRUE,NULL,'F808 PRIVATE FORMAT','{"secret":"F808 PRIVATE META"}'),
  (geocode_two,address_one,own_org,own_client,'manual',ST_SetSRID(ST_MakePoint(46.8,24.8),4326)::geography,FALSE,now()-interval '1 day','F808 PRIVATE FORMAT','{"secret":"F808 PRIVATE META"}'),
  (geocode_one,address_two,own_org,own_client,'manual',ST_SetSRID(ST_MakePoint(39.2,21.5),4326)::geography,FALSE,NULL,'F808 PRIVATE FORMAT','{"secret":"F808 PRIVATE META"}'),
  (gen_random_uuid(),address_one,own_org,sibling_client,'manual',ST_SetSRID(ST_MakePoint(47,25),4326)::geography,FALSE,NULL,NULL,NULL),
  (gen_random_uuid(),address_one,foreign_org,foreign_client,'manual',ST_SetSRID(ST_MakePoint(48,26),4326)::geography,FALSE,NULL,NULL,NULL);

 FOREACH identity IN ARRAY ARRAY[tenant_actor,client_actor] LOOP
  PERFORM set_config('request.jwt.claim.sub',identity::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',identity,'role','authenticated')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE authenticated';
  result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
  RETURN NEXT is(jsonb_array_length(result->'items'),CASE WHEN identity=tenant_actor THEN 4 ELSE 3 END,'authorized pins exist without any shipment and exclude foreign scope');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'longitude'='48'),'foreign organization pin excluded');
  RETURN NEXT is((SELECT count(DISTINCT e->>'id') FROM jsonb_array_elements(result->'items') e),jsonb_array_length(result->'items')::bigint,'composite geocode identities remain distinct');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'id'=geocode_one::text||':'||address_one::text AND abs((e->>'latitude')::numeric-24.7)<0.000001 AND abs((e->>'longitude')::numeric-46.7)<0.000001),'native geocode projection preserves latitude and longitude order');
  RETURN NEXT is(api.ui_list_resource_v1('tracking_geocode_pins','{}',1,1,NULL)->'items'->0,result->'items'->1,'stable composite-id pagination preserves the second row');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'id'=geocode_two::text||':'||address_one::text),'non-primary expired geocode remains selected');
  RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->'label'<>'null'::jsonb OR e->'source'<>'null'::jsonb),'unproven label/source are null');
  RETURN NEXT ok(result::text NOT LIKE '%F808 PRIVATE%' AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e ?| ARRAY['metadata','formatted_address','raw_input','line1','provider_name']),'API output omits raw metadata and PII');
  result:=api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL);
  RETURN NEXT is(jsonb_array_length(result->'items'),CASE WHEN identity=tenant_actor THEN 3 ELSE 2 END,'coordinate address dataset excludes null coordinates and foreign scope');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'label'='North, Riyadh' AND e->>'tone'='neutral'),'address fallback label and neutral tone preserved');
  RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'id'=address_one::text||':'||own_client::text AND abs((e->>'latitude')::numeric-24.7)<0.000001 AND abs((e->>'longitude')::numeric-46.7)<0.000001),'native address projection preserves latitude and longitude order');
  EXECUTE 'SET LOCAL ROLE postgres';
 END LOOP;

 INSERT INTO public.shipments(id,organization_id,client_id,sender_id,service_type,tracking_number,status,origin_address_id,destination_address_id) VALUES
  (own_shipment,own_org,own_client,own_sender,'delivery','f808-'||own_shipment,'created',address_one,address_null),
  (other_shipment,own_org,own_client,other_sender,'delivery','f808-'||other_shipment,'created',address_two,NULL),
  (gen_random_uuid(),own_org,sibling_client,NULL,'delivery','f808-'||gen_random_uuid(),'created',address_one,NULL),
  (gen_random_uuid(),foreign_org,foreign_client,NULL,'delivery','f808-'||gen_random_uuid(),'created',address_one,NULL);
 PERFORM set_config('request.jwt.claim.sub',client_actor::text,TRUE);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',client_actor,'role','authenticated')::text,TRUE);
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_shipments','{}',100,0,NULL);
 RETURN NEXT is(jsonb_array_length(result->'items'),2,'client shipment fallback excludes sibling client and foreign organization');
 RETURN NEXT ok(EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'tracking_number'='f808-'||other_shipment AND e->'destination_city'='null'::jsonb),'missing destination address is represented by null city');
 EXECUTE 'SET LOCAL ROLE postgres';
 PERFORM set_config('request.jwt.claim.sub',sender_actor::text,TRUE);
 PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',sender_actor,'role','authenticated')::text,TRUE);
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
 RETURN NEXT is(jsonb_array_length(result->'items'),2,'sender gets only shipment-linked address geocodes');
 RETURN NEXT ok(NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e->>'address_id'=address_two::text),'sender cannot see another sender address');
 result:=api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL);
 RETURN NEXT is(jsonb_array_length(result->'items'),1,'sender coordinate-address fallback preserves shipment link');
 result:=api.ui_list_resource_v1('tracking_shipments','{}',100,0,NULL);
 RETURN NEXT is(jsonb_array_length(result->'items'),1,'shipment fallback is sender-scoped');
 row_value:=result->'items'->0;
 RETURN NEXT ok(row_value ?& ARRAY['tracking_number','status','origin_city','destination_city','service_type','updated_at'],'shipment fallback returns all six selected fields');
 RETURN NEXT is(row_value->>'origin_city','Riyadh','composite address join does not borrow duplicate-id sibling/foreign city');
 RETURN NEXT is(row_value->>'destination_city','Dammam','coordinate-less destination city remains available');
 RETURN NEXT is(row_value->>'tracking_number','f808-'||own_shipment,'shipment tracking identity preserved');
 EXECUTE 'SET LOCAL ROLE postgres';

 -- Scoped presentation cannot change the global security projection.
 SELECT jsonb_set(registry,'{resources}',jsonb_agg(CASE WHEN e->>'key'='tracking_geocode_pins'
  THEN jsonb_set(e,'{select}','["id"]'::jsonb) ELSE e END ORDER BY n)) INTO overridden
  FROM jsonb_array_elements(registry->'resources') WITH ORDINALITY x(e,n);
 PERFORM public.upsert_settings_value_v1('ui_read_registry','sender',own_sender,overridden,registry_version,'F808 owned select suppression');
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
 RETURN NEXT ok(jsonb_array_length(result->'items')=2 AND result->'items'->0 ? 'latitude','scoped select override cannot replace canonical projection');
 EXECUTE 'SET LOCAL ROLE postgres';
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,overridden,registry_version,'F808 global select suppression');
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
 RETURN NEXT ok(jsonb_array_length(result->'items')=2 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e WHERE e-'id'<>'{}'::jsonb),'canonical select suppression remains authoritative');
 result:=api.ui_list_resource_v1('tracking_shipments','{}',100,0,NULL);
 RETURN NEXT ok(result->'items'->0 ? 'origin_city','geocode override does not suppress independently authorized shipment selection');
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT jsonb_set(overridden,'{resources}',jsonb_agg(CASE WHEN e->>'key'='tracking_geocode_pins'
  THEN e || '{"read_relation":"public.tracking_address_pins_v1"}'::jsonb ELSE e END ORDER BY n)) INTO overridden
  FROM jsonb_array_elements(overridden->'resources') WITH ORDINALITY x(e,n);
 PERFORM public.upsert_settings_value_v1('ui_read_registry','sender',own_sender,overridden,registry_version,'F808 owned read relation override');
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
 RETURN NEXT ok(jsonb_array_length(result->'items')=2 AND EXISTS(SELECT 1 FROM jsonb_array_elements(result->'items') e
  WHERE e->>'id'=geocode_one::text||':'||address_one::text),'scoped read_relation override cannot redirect canonical relation');
 EXECUTE 'SET LOCAL ROLE postgres';
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,overridden,registry_version,'F808 global read relation override');
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL);
 RETURN NEXT ok(jsonb_array_length(result->'items')=1 AND result->'items'->0->>'id'=address_one::text||':'||own_client::text,'canonical read_relation override remains authoritative');
 EXECUTE 'SET LOCAL ROLE postgres';
 -- UUID get API uses an owned UUID id_column override; composite pin IDs stay unchanged.
 SELECT jsonb_set(registry,'{resources}',jsonb_agg(CASE WHEN e->>'key'='tracking_address_pins'
  THEN e || '{"id_column":"address_id","select":["id"]}'::jsonb ELSE e END ORDER BY n)) INTO overridden
  FROM jsonb_array_elements(registry->'resources') WITH ORDINALITY x(e,n);
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,overridden,registry_version,'F808 list and get selected output');
 EXECUTE 'SET LOCAL ROLE authenticated';
 result:=api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL);
 RETURN NEXT ok(result->'keys'='["id","address_id"]'::jsonb AND jsonb_array_length(result->'items')=1
  AND result->'items'->0->>'address_id'=address_one::text AND (result->'items'->0)-ARRAY['id','address_id']='{}'::jsonb,
  'list output includes selected id plus mandatory address identity');
 result:=api.ui_get_resource_v1('tracking_address_pins',address_one);
 RETURN NEXT ok(result->>'id'=address_one::text||':'||own_client::text AND result->>'address_id'=address_one::text
  AND result-ARRAY['id','address_id']='{}'::jsonb,'get output includes selected id plus mandatory address identity');
 EXECUTE 'SET LOCAL ROLE postgres';
 SELECT jsonb_set(overridden,'{resources}',jsonb_agg(CASE WHEN e->>'key'='tracking_address_pins'
  THEN e-'select' ELSE e END ORDER BY n)) INTO overridden
  FROM jsonb_array_elements(overridden->'resources') WITH ORDINALITY x(e,n);
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,overridden,registry_version,'F808 absent selection denial');
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok($q$SELECT api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL)$q$,
  'P0001','ui_read_registry resource tracking_address_pins requires a non-empty select array','absent list selection fails closed');
 RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(%L,%L::uuid)','tracking_address_pins',address_one),
  'P0001','ui_read_registry resource tracking_address_pins requires a non-empty select array','absent get selection fails closed');
 EXECUTE 'SET LOCAL ROLE postgres';
 FOR entry IN SELECT value FROM jsonb_array_elements('[[],["missing_column"],["*"]]'::jsonb) LOOP
  SELECT jsonb_set(overridden,'{resources}',jsonb_agg(CASE WHEN e->>'key'='tracking_address_pins'
   THEN jsonb_set(e,'{select}',entry) ELSE e END ORDER BY n)) INTO overridden
   FROM jsonb_array_elements(overridden->'resources') WITH ORDINALITY x(e,n);
  PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,overridden,registry_version,'F808 selection intersection');
  EXECUTE 'SET LOCAL ROLE authenticated';
  IF jsonb_array_length(entry)=0 THEN
   RETURN NEXT throws_ok($q$SELECT api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL)$q$,
    'P0001','ui_read_registry resource tracking_address_pins requires a non-empty select array of column names','empty list selection fails closed');
   RETURN NEXT throws_ok(format('SELECT api.ui_get_resource_v1(%L,%L::uuid)','tracking_address_pins',address_one),
    'P0001','ui_read_registry resource tracking_address_pins requires a non-empty select array of column names','empty get selection fails closed');
  ELSE
   result:=api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL);
   RETURN NEXT ok(result->'keys'='["address_id"]'::jsonb AND jsonb_array_length(result->'items')=1
    AND result->'items'->0=jsonb_build_object('address_id',address_one),'unknown list columns intersect away and never expand to wildcard');
   RETURN NEXT is(api.ui_get_resource_v1('tracking_address_pins',address_one),jsonb_build_object('address_id',address_one),
    'unknown get columns intersect away and preserve only mandatory identity');
  END IF;
  EXECUTE 'SET LOCAL ROLE postgres';
 END LOOP;
 PERFORM public.upsert_settings_value_v1('ui_read_registry','global',NULL,registry,registry_version,'F808 restore canonical registry for denial matrix');
 PERFORM public.upsert_settings_value_v1('ui_read_registry','sender',own_sender,registry,registry_version,'F808 restore owned presentation for denial matrix');

 access_policy:=jsonb_set(access_policy,'{denies}','[{"capability_key":"addresses.read"}]'::jsonb);
 PERFORM public.upsert_settings_value_v1('access_control_policy','sender',own_sender,access_policy,access_version,'F808 owned capability denial');
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok($q$SELECT api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL)$q$,'42501','Capability denied: addresses.read','addresses.read denial fails closed at API');
 RETURN NEXT throws_ok($q$SELECT api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL)$q$,'42501','Capability denied: addresses.read','address fallback cannot bypass denied capability');
 result:=api.ui_list_resource_v1('tracking_shipments','{}',100,0,NULL);
 RETURN NEXT ok(jsonb_array_length(result->'items')=1 AND result->'items'->0->'origin_city'='null'::jsonb AND result->'items'->0->'destination_city'='null'::jsonb,'shipment grant does not reveal address cities without addresses.read');
 EXECUTE 'SET LOCAL ROLE postgres';
 access_policy:=jsonb_set(access_policy,'{denies}','[{"capability_key":"shipments.read"}]'::jsonb);
 PERFORM public.upsert_settings_value_v1('access_control_policy','sender',own_sender,access_policy,access_version,'F808 owned shipment capability denial');
 EXECUTE 'SET LOCAL ROLE authenticated';
 RETURN NEXT throws_ok($q$SELECT api.ui_list_resource_v1('tracking_shipments','{}',100,0,NULL)$q$,'42501','Capability denied: shipments.read','shipment fallback requires its independent capability');
 RETURN NEXT is(jsonb_array_length(api.ui_list_resource_v1('tracking_geocode_pins','{}',100,0,NULL)->'items'),0,'sender address pins cannot bypass shipment RLS when shipment capability is denied');
 RETURN NEXT is(jsonb_array_length(api.ui_list_resource_v1('tracking_address_pins','{}',100,0,NULL)->'items'),0,'sender coordinate fallback cannot bypass shipment RLS when shipment capability is denied');
 EXECUTE 'SET LOCAL ROLE postgres';
 FOR entry IN SELECT to_jsonb(c) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
  WHERE n.nspname='public' AND c.relname IN ('tracking_geocode_pins_v1','tracking_address_pins_v1','tracking_shipments_v1') LOOP
  RETURN NEXT ok(entry->'reloptions' @> '["security_invoker=true"]'::jsonb,'projection remains security invoker');
 END LOOP;
 RETURN NEXT ok(NOT has_table_privilege('authenticated','public.tracking_geocode_pins_v1','SELECT'),'direct projection access is not a registry bypass');
 RETURN NEXT ok(NOT has_table_privilege('anon','public.tracking_shipments_v1','SELECT'),'anon cannot read shipment projection');
END;
$test$;
SELECT * FROM pg_temp.f808_projection_matrix();
SELECT * FROM finish();
ROLLBACK;
