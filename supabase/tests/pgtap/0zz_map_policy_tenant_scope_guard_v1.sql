-- E56 scope behavior, not cached-tile qualification.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SELECT plan(23);
CREATE FUNCTION pg_temp.e56_scope_matrix() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $test$
DECLARE
  own_org UUID := gen_random_uuid();
  other_org UUID := gen_random_uuid();
  actor UUID := gen_random_uuid();
  own_client UUID := gen_random_uuid();
  other_client UUID := gen_random_uuid();
  own_sender UUID := gen_random_uuid();
  selected_version UUID;
  other_version UUID;
  baseline JSONB;
  schema_version INTEGER;
  candidate JSONB;
  sender_resolution RECORD;
BEGIN
  -- Exercise tenant fallback, not onboarding-created client/sender overrides.
  -- This supported policy override and all owned rows roll back together.
  SELECT sv.value,sv.schema_version INTO STRICT baseline,schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='saas_onboarding_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
  PERFORM public.upsert_settings_value_v1('saas_onboarding_policy','global',NULL,
    jsonb_set(baseline,'{enabled}','false'::jsonb),schema_version,'rollback map tenant-fallback fixture');
  INSERT INTO public.organizations(id,name,slug,billing_status) VALUES
    (own_org,'Map scope owned','map-'||own_org,'active'),
    (other_org,'Map scope foreign','map-'||other_org,'active');
  INSERT INTO public.clients(id,organization_id,name,slug,status) VALUES
    (own_client,own_org,'Map client','map-'||own_client,'active'),
    (other_client,other_org,'Other client','map-'||other_client,'active');
  INSERT INTO public.senders(id,client_id,name,status)
    VALUES(own_sender,own_client,'Map sender','active');
  INSERT INTO public.users(id,organization_id,email,full_name,user_type,status,access_scope_type,access_scope_id)
    VALUES(actor,own_org,'map-'||actor||'@example.test','Map tenant','ops_admin','active','tenant',NULL);
  SELECT sv.value,sv.schema_version INTO STRICT baseline,schema_version
    FROM public.settings s JOIN public.settings_versions sv ON sv.id=s.settings_version_id
    WHERE s.category='map_policy' AND s.scope_type='global' AND s.scope_id IS NULL;
  SELECT settings_version_id INTO STRICT selected_version
    FROM public.upsert_settings_value_v1('map_policy','tenant',own_org,baseline,schema_version,'rollback map scope fixture');
  SELECT settings_version_id INTO STRICT other_version
    FROM public.upsert_settings_value_v1('map_policy','tenant',other_org,baseline,schema_version,'rollback foreign map fixture');
  PERFORM set_config('request.jwt.claim.sub',actor::text,TRUE);
  PERFORM set_config('request.jwt.claim.role','authenticated',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','authenticated')::text,TRUE);
  RETURN NEXT is(public.current_user_org_id(),own_org,'fixture resolves the actual active tenant');
  RETURN NEXT is((SELECT settings_version_id FROM public.resolve_map_policy(jsonb_build_object('organization_id',own_org))),selected_version,'own tenant resolves exact version');
  SELECT * INTO STRICT sender_resolution
    FROM public.resolve_map_policy(jsonb_build_object('sender_id',own_sender));
  IF sender_resolution.settings_version_id IS DISTINCT FROM selected_version THEN
    RETURN NEXT diag(jsonb_build_object(
      'winner_scope',sender_resolution.scope_type,
      'winner_is_owned_tenant',sender_resolution.scope_type='tenant' AND sender_resolution.scope_id=own_org,
      'winner_is_owned_client',sender_resolution.scope_type='client' AND sender_resolution.scope_id=own_client,
      'winner_is_owned_sender',sender_resolution.scope_type='sender' AND sender_resolution.scope_id=own_sender,
      'tenant_scope_evaluated',EXISTS(SELECT 1 FROM jsonb_array_elements(sender_resolution.scope_path) x
        WHERE x->>'scope_type'='tenant' AND x->>'scope_id'=own_org::text),
      'sender_parent_matches',EXISTS(SELECT 1 FROM public.senders WHERE id=own_sender AND client_id=own_client),
      'client_parent_matches',EXISTS(SELECT 1 FROM public.clients WHERE id=own_client AND organization_id=own_org)
    )::text);
  END IF;
  RETURN NEXT is(sender_resolution.settings_version_id,selected_version,'sender derives own tenant and exact version');
  RETURN NEXT throws_ok(format('SELECT * FROM public.resolve_map_policy(%L::jsonb)',jsonb_build_object('organization_id',other_org)), '42501', NULL, 'elevated SQL role does not override authenticated foreign-tenant denial');
  RETURN NEXT throws_ok(format('SELECT * FROM public.resolve_map_policy(%L::jsonb)',jsonb_build_object('organization_id',own_org,'client_id',other_client)), '42501', NULL, 'mixed organization/client lineage fails');
  RETURN NEXT throws_ok($q$SELECT * FROM public.resolve_map_policy('[]'::jsonb)$q$, '22023', NULL, 'nonobject context fails');
  RETURN NEXT throws_ok($q$SELECT * FROM public.resolve_map_policy('{"organization_id":null}'::jsonb)$q$, '22023', NULL, 'explicit null identifier fails');
  RETURN NEXT throws_ok($q$SELECT * FROM public.resolve_map_policy('{"sender_id":"invalid"}'::jsonb)$q$, '22023', NULL, 'malformed identifier fails');
  RETURN NEXT throws_ok($q$SELECT * FROM public.resolve_map_policy('{"client_id":42}'::jsonb)$q$, '22023', NULL, 'nonstring identifier fails');
  RETURN NEXT throws_ok(format('SELECT * FROM public.resolve_map_policy(%L::jsonb)',jsonb_build_object('webhook_source_id',gen_random_uuid())), '42501', NULL, 'unknown source does not fall back');
  RETURN NEXT throws_ok($q$SELECT public.map_policy_assert_scope_path_v1('[]'::jsonb)$q$, '22023', NULL, 'empty evaluated path fails');
  RETURN NEXT throws_ok($q$SELECT public.map_policy_assert_scope_path_v1('[{"scope_type":"global","scope_id":null},{"scope_type":"global","scope_id":null}]'::jsonb)$q$, '22023', NULL, 'duplicate global path fails');
  RETURN NEXT throws_ok(format('SELECT public.map_policy_assert_scope_path_v1(%L::jsonb)',jsonb_build_array(jsonb_build_object('scope_type','tenant','scope_id',other_org),jsonb_build_object('scope_type','global','scope_id',NULL))), '42501', NULL, 'foreign evaluated path fails');
  -- Registry override and fixture rows are transaction-local and rolled back.
  UPDATE public.settings_category_registry SET resource_scope_rel='public.clients'::regclass WHERE category='map_policy';
  RETURN NEXT is((SELECT settings_version_id FROM public.resolve_map_policy(jsonb_build_object('resource_id',own_client))),selected_version,'resource ownership follows registry relation');
  RETURN NEXT throws_ok(format('SELECT * FROM public.resolve_map_policy(%L::jsonb)',jsonb_build_object('resource_id',other_client)), '42501', NULL, 'foreign registry resource fails');
  EXECUTE 'SET LOCAL ROLE authenticated';
  RETURN NEXT is((SELECT settings_version_id FROM api.resolve_map_policy(jsonb_build_object('organization_id',own_org))),selected_version,'authenticated dedicated API resolves exact version');
  RETURN NEXT throws_ok(format('SELECT * FROM api.resolve_map_policy(%L::jsonb)',jsonb_build_object('organization_id',other_org)), '42501', NULL, 'dedicated API denies foreign context');
  RETURN NEXT throws_ok($q$SELECT * FROM api.resolve_settings_row_from_policy_context_v1('map_policy','{}'::jsonb)$q$, '42501', NULL, 'authenticated generic API stays forbidden');
  EXECUTE 'SET LOCAL ROLE postgres';
  PERFORM set_config('request.jwt.claim.role','service_role',TRUE);
  PERFORM set_config('request.jwt.claims',jsonb_build_object('sub',actor,'role','service_role')::text,TRUE);
  EXECUTE 'SET LOCAL ROLE service_role';
  RETURN NEXT is((SELECT settings_version_id FROM api.resolve_settings_row_from_policy_context_v1('map_policy',jsonb_build_object('organization_id',other_org))),other_version,'service JWT resolves coherent foreign map scope through generic API');
  RETURN NEXT throws_ok(format('SELECT * FROM public.resolve_map_policy(%L::jsonb)',jsonb_build_object('organization_id',own_org,'client_id',other_client)), '42501', NULL, 'service JWT cannot bypass mixed lineage');
  SELECT to_jsonb(r) INTO STRICT candidate FROM public.resolve_settings_row_from_policy_context_v1('device_policy','{}'::jsonb) r;
  RETURN NEXT is((SELECT to_jsonb(r) FROM api.resolve_settings_row_from_policy_context_v1('device_policy','{}'::jsonb) r),candidate,'non-map generic category result unchanged');
  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(NOT has_function_privilege('anon','api.resolve_settings_row_from_policy_context_v1(text,jsonb)','EXECUTE'),'anon generic API stays forbidden');
  RETURN NEXT ok(NOT has_function_privilege('authenticated','public.map_policy_assert_context_scope_v1(jsonb)','EXECUTE'),'internal context helper is not browser-callable');
END;
$test$;
SELECT * FROM pg_temp.e56_scope_matrix();
SELECT * FROM finish();
ROLLBACK;
