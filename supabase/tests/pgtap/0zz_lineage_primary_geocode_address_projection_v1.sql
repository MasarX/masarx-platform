BEGIN;
SET LOCAL search_path TO public,extensions,pg_temp;
SELECT plan(26);
SELECT has_function('public','project_address_from_primary_geocode_v1',ARRAY['uuid'],
  'canonical address projection exists');
SELECT has_function('public','project_address_from_primary_geocode_v1',ARRAY['uuid','uuid'],
  'trigger projection uses the composite address/client identity');
SELECT has_trigger('public','geocodes','geocodes_project_primary_address',
  'primary geocode writes invoke projection');
SELECT ok(NOT has_function_privilege('authenticated',
  'public.project_address_from_primary_geocode_v1(uuid)','EXECUTE'),
  'the cross-client system projection is not a public RPC');

CREATE FUNCTION pg_temp.lineage_geocode_projection_cases() RETURNS SETOF text
LANGUAGE plpgsql AS $test$
DECLARE
  org uuid:=gen_random_uuid(); client uuid:=gen_random_uuid(); no_pin_client uuid:=gen_random_uuid();
  pinned uuid:=gen_random_uuid(); projected uuid:=gen_random_uuid(); expired uuid:=gen_random_uuid();
  shared uuid:=gen_random_uuid(); corrected uuid:=gen_random_uuid(); scoped uuid:=gen_random_uuid();
  projected_geo uuid:=gen_random_uuid(); actor uuid:=gen_random_uuid();
  schema_ver integer; policy jsonb; selected_client uuid; provided boolean;
  result jsonb; before_skip text; client_policy jsonb;
BEGIN
  PERFORM set_config('request.jwt.claim.sub','',true);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',true);
  INSERT INTO public.organizations(id,name,slug)
    VALUES(org,'Lineage projection','lineage-projection-'||left(org::text,8));
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (client,org,'Lineage pin client','lineage-pin-'||left(client::text,8),'active'),
    (no_pin_client,org,'Lineage projection client','lineage-no-pin-'||left(no_pin_client::text,8),'active');
  SELECT s.cached_value,sv.schema_version INTO STRICT policy,schema_ver
  FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
  WHERE s.category='geocoding_policy' AND s.scope_type='global' LIMIT 1;
  FOR selected_client,provided IN SELECT * FROM (VALUES(client,TRUE),(no_pin_client,FALSE)) x(id,allow_pin)
  LOOP
    client_policy:=policy||jsonb_build_object(
      'local_lookup',COALESCE(policy->'local_lookup','{}'::jsonb)||'{"min_confidence":0.8}'::jsonb,
      'coordinate_handling',COALESCE(policy->'coordinate_handling','{}'::jsonb)||
        jsonb_build_object('use_provided_coordinates',provided));
    PERFORM public.upsert_settings_value_v1('geocoding_policy','client',selected_client,
      client_policy,schema_ver,'Lineage projection test');
  END LOOP;
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,access_scope_type,access_scope_id)
  VALUES(actor,org,'lineage-geocode-'||left(actor::text,8)||'@example.com','Scoped geocode writer','client_admin','client',client);
  before_skip:=COALESCE(current_setting('app.address_versioning_skip',true),'');
  PERFORM set_config('app.address_versioning_skip','1',true);
  INSERT INTO public.addresses(id,organization_id,client_id,raw_input,city,province,country,validation_status,coordinates)
  VALUES
    (pinned,org,client,'{"lat":24.7136,"lng":46.6753}','Riyadh','Riyadh','SA','pending',NULL),
    (projected,org,no_pin_client,'{"lat":24.7136,"lng":46.6753}','Riyadh','Riyadh','SA','pending',NULL),
    (expired,org,client,'{"line1":"Expired result"}','Riyadh','Riyadh','SA','pending',NULL),
    (corrected,org,client,'{"line1":"Manual correction"}','Riyadh','Riyadh','SA','valid',ST_SetSRID(ST_MakePoint(9,9),4326)::geography),
    (shared,org,client,'{"line1":"Shared UUID client A"}','Riyadh','Riyadh','SA','pending',NULL),
    (shared,org,no_pin_client,'{"line1":"Shared UUID client B"}','Riyadh','Riyadh','SA','pending',NULL),
    (scoped,org,client,'{"line1":"Scoped writer"}','Riyadh','Riyadh','SA','pending',NULL);
  UPDATE public.addresses SET last_corrected_at=now(),correction_count=1 WHERE id=corrected AND client_id=client;
  PERFORM set_config('app.address_versioning_skip',before_skip,true);
  INSERT INTO public.geocodes(id,address_id,client_id,provider_name,coordinates,confidence_score,is_primary,expires_at)
  VALUES(gen_random_uuid(),pinned,client,'canonical_lookup',ST_SetSRID(ST_MakePoint(47.5,25.5),4326)::geography,0.9,TRUE,now()+interval '1 day'),
        (projected_geo,projected,no_pin_client,'canonical_lookup',ST_SetSRID(ST_MakePoint(47.5,25.5),4326)::geography,0.9,TRUE,now()+interval '1 day'),
        (gen_random_uuid(),expired,client,'canonical_lookup',ST_SetSRID(ST_MakePoint(47.5,25.5),4326)::geography,0.9,TRUE,now()-interval '1 day');
  RETURN NEXT is((SELECT validation_status FROM public.addresses WHERE id=pinned),'valid',
    'successful primary geocode automatically validates the address');
  RETURN NEXT is((SELECT round(ST_Y(coordinates::geometry)::numeric,4) FROM public.addresses WHERE id=pinned),
    24.7136::numeric,'policy-enabled submitted pin survives centroid projection');
  result:=public.project_address_from_primary_geocode_v1(pinned);
  RETURN NEXT is(result->>'coordinate_source','provided_coordinates','readback identifies submitted-coordinate truth');
  RETURN NEXT is((SELECT round(ST_Y(coordinates::geometry)::numeric,4) FROM public.addresses WHERE id=projected),
    25.5::numeric,'policy-disabled pin uses the selected geocode coordinates');
  RETURN NEXT is((result->>'min_confidence')::numeric,0.8::numeric,'projection uses the scoped confidence policy');
  UPDATE public.geocodes SET confidence_score=0.1 WHERE address_id=projected AND is_primary IS TRUE;
  RETURN NEXT ok((SELECT validation_status='needs_review'
    FROM public.addresses WHERE id=projected),'low confidence projects the carrier needs_review TEXT state');
  result:=public.project_address_from_primary_geocode_v1(expired);
  RETURN NEXT is(result->>'reason','primary_geocode_missing','expired primary results cannot project');
  RETURN NEXT is((SELECT validation_status FROM public.addresses WHERE id=expired),'pending',
    'expired result leaves canonical address state unchanged');
  PERFORM set_config('app.address_versioning_skip','1',true);
  PERFORM public.project_address_from_primary_geocode_v1(pinned);
  RETURN NEXT is(current_setting('app.address_versioning_skip',true),'1',
    'projection preserves an existing versioning context flag');
  PERFORM set_config('app.address_versioning_skip',before_skip,true);
  -- Two real address rows share an ID across clients, as allowed by the carrier composite PK.
  INSERT INTO public.geocodes(id,address_id,client_id,provider_name,coordinates,confidence_score,is_primary) VALUES
    (gen_random_uuid(),shared,client,'canonical_lookup',ST_SetSRID(ST_MakePoint(20,20),4326)::geography,0.9,TRUE),
    (gen_random_uuid(),shared,no_pin_client,'canonical_lookup',ST_SetSRID(ST_MakePoint(30,30),4326)::geography,0.9,TRUE),
    (gen_random_uuid(),corrected,client,'canonical_lookup',ST_SetSRID(ST_MakePoint(40,40),4326)::geography,0.1,TRUE);
  RETURN NEXT is((SELECT ST_Y(coordinates::geometry)::numeric FROM public.addresses WHERE id=shared AND client_id=client),
    20::numeric,'projection selects the matching client A address on a shared UUID');
  RETURN NEXT is((SELECT ST_Y(coordinates::geometry)::numeric FROM public.addresses WHERE id=shared AND client_id=no_pin_client),
    30::numeric,'client B primary never overwrites client A coordinates');
  result:=public.project_address_from_primary_geocode_v1(shared);
  RETURN NEXT is(result->>'reason','address_ambiguous','UUID-only compatibility calls do not guess across clients');
  result:=public.project_address_from_primary_geocode_v1(pinned,no_pin_client);
  RETURN NEXT is(result->>'reason','address_missing','explicit wrong-client projection is a non-mutating result');
  RETURN NEXT throws_ok(format('INSERT INTO public.geocodes(id,address_id,client_id,provider_name,coordinates,is_primary) VALUES (gen_random_uuid(),%L::uuid,%L::uuid,%L,ST_SetSRID(ST_MakePoint(50,50),4326)::geography,TRUE)',
    pinned,no_pin_client,'canonical_lookup'),'23503',NULL,'real composite FK rejects a cross-client geocode link');
  RETURN NEXT is((SELECT round(ST_Y(coordinates::geometry)::numeric,4) FROM public.addresses WHERE id=pinned AND client_id=client),
    24.7136::numeric,'rejected cross-client write leaves the submitted pin unchanged');
  RETURN NEXT ok((SELECT validation_status='valid' AND ST_Y(coordinates::geometry)=9 AND correction_count=1
    FROM public.addresses WHERE id=corrected AND client_id=client),'later low-confidence results preserve operator correction coordinates and status');
  result:=public.project_address_from_primary_geocode_v1(corrected,client);
  RETURN NEXT is(result->>'reason','manual_correction_preserved','manual-correction preservation is explicit in projection readback');
  UPDATE public.geocodes SET is_primary=FALSE WHERE id=projected_geo AND address_id=projected;
  RETURN NEXT ok((SELECT validation_status='needs_review' AND ST_Y(coordinates::geometry)=25.5
    FROM public.addresses WHERE id=projected AND client_id=no_pin_client),'deselecting the last primary keeps the prior address projection');
  DELETE FROM public.geocodes WHERE id=projected_geo AND address_id=projected;
  RETURN NEXT ok((SELECT validation_status='needs_review' AND ST_Y(coordinates::geometry)=25.5
    FROM public.addresses WHERE id=projected AND client_id=no_pin_client),'deleting a primary history row also keeps the prior projection');
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  INSERT INTO public.geocodes(id,address_id,client_id,provider_name,coordinates,confidence_score,is_primary) VALUES
    (gen_random_uuid(),scoped,client,'canonical_lookup',ST_SetSRID(ST_MakePoint(10,10),4326)::geography,0.9,TRUE);
  RETURN NEXT ok((SELECT coordinates IS NULL AND validation_status='pending' FROM public.addresses WHERE id=scoped AND client_id=client),
    'a scoped geocode writer does not gain the carrier tenant-only address-update capability');
  PERFORM set_config('request.jwt.claim.sub','',TRUE);
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims','{"role":"service_role"}',TRUE);
  result:=public.project_address_from_primary_geocode_v1(scoped,client);
  RETURN NEXT ok((result->>'projected')::boolean AND (SELECT validation_status='valid' FROM public.addresses WHERE id=scoped AND client_id=client),
    'trusted system projection remains available for a pending row with an existing primary');
  result:=public.project_address_from_primary_geocode_v1(gen_random_uuid());
  RETURN NEXT is(result->>'reason','address_missing','unknown address is a non-mutating result');
END;
$test$;
SELECT * FROM pg_temp.lineage_geocode_projection_cases();
SELECT * FROM finish();
ROLLBACK;
