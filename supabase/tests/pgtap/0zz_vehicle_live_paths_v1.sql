-- Plan: Console V2 fleet vehicle live paths.
-- Asserts vehicle create, vehicle documents, api-schema wrappers, and
-- telemetry fields on v_vehicle_directory.

SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(18);

CREATE OR REPLACE FUNCTION test_vehicle_live_paths_v1()
RETURNS SETOF TEXT
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org1 UUID := '0fb09000-0000-0000-0000-000000000001'::uuid;
  v_branch1 UUID := '0fb09000-0000-0000-0000-000000000101'::uuid;
  v_admin1 UUID := '0fb09000-0000-0000-0000-000000000401'::uuid;
  v_unpriv1 UUID := '0fb09000-0000-0000-0000-000000000402'::uuid;
  v_vehicle_type1 UUID := '0fb09000-0000-0000-0000-000000000601'::uuid;
  v_artifact1 UUID := '0fb09000-0000-0000-0000-000000000901'::uuid;

  v_create_result JSONB;
  v_upload_result JSONB;
  v_vehicle_id UUID;
  v_vehicle_document_id UUID;
BEGIN
  RETURN NEXT has_table('public', 'vehicle_documents', 'vehicle_documents table exists');
  RETURN NEXT has_function('public', 'create_vehicle_v1', ARRAY['jsonb'], 'public.create_vehicle_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'create_vehicle_v1', ARRAY['jsonb'], 'api.create_vehicle_v1(jsonb) exists');
  RETURN NEXT has_function('public', 'upload_vehicle_document_v1', ARRAY['jsonb'], 'public.upload_vehicle_document_v1(jsonb) exists');
  RETURN NEXT has_function('api', 'upload_vehicle_document_v1', ARRAY['jsonb'], 'api.upload_vehicle_document_v1(jsonb) exists');
  RETURN NEXT has_column('public', 'v_vehicle_directory', 'fuel_level', 'v_vehicle_directory exposes fuel_level');
  RETURN NEXT has_column('public', 'v_vehicle_directory', 'odometer_km', 'v_vehicle_directory exposes odometer_km');
  RETURN NEXT has_column('public', 'v_vehicle_directory', 'last_telemetry_at', 'v_vehicle_directory exposes last_telemetry_at');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'vehicle_document_kind'
         AND lv.value = 'registration'
    ),
    'vehicle_document_kind includes registration'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.lookup_definitions ld
        JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
       WHERE ld.category = 'vehicle_document_status'
         AND lv.value = 'submitted'
         AND lv.is_default IS TRUE
    ),
    'vehicle_document_status has submitted default'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org1, 'Vehicle Live Paths Org', 'vehicle-live-paths-' || left(v_org1::text, 8));

  INSERT INTO public.branches (id, organization_id, code, name, timezone, is_active)
  VALUES (v_branch1, v_org1, 'vlp-b1', 'Vehicle Live Paths Branch', 'UTC', TRUE);

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type)
  VALUES
    (v_admin1, v_org1, 'vehicle-live-admin@example.com', 'Vehicle Live Admin', 'fleet_manager', 'tenant'),
    (v_unpriv1, v_org1, 'vehicle-live-unpriv@example.com', 'Vehicle Live Unprivileged', 'client_admin', 'tenant');

  INSERT INTO public.vehicle_types (id, organization_id, key, name, is_active, metadata)
  VALUES (
    v_vehicle_type1,
    v_org1,
    'van-' || left(v_vehicle_type1::text, 6),
    'Vehicle Live Van',
    TRUE,
    jsonb_build_object('fuel_capacity_liters', 60)
  );

  INSERT INTO public.artifacts (
    id,
    organization_id,
    storage_bucket,
    storage_key,
    mime_type,
    size_bytes,
    sha256,
    created_by_user_id,
    source_system,
    metadata
  )
  VALUES (
    v_artifact1,
    v_org1,
    'vehicle-documents-test',
    'vehicles/registration.pdf',
    'application/pdf',
    1024,
    'vehicledocsha256',
    v_admin1,
    'pgtap',
    jsonb_build_object('test', 'vehicle_live_paths')
  );

  PERFORM public.provision_rbac_roles_from_templates_v1(v_org1, ARRAY['fleet_manager'], v_admin1);
  INSERT INTO public.rbac_user_role_assignments (organization_id, user_id, role_id, assigned_by_user_id, metadata)
  SELECT v_org1, v_admin1, r.id, v_admin1, jsonb_build_object('seed', TRUE, 'source', 'pgtap')
  FROM public.rbac_roles r
  WHERE r.organization_id = v_org1
    AND r.key = 'fleet_manager'
  ON CONFLICT DO NOTHING;

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.create_vehicle_v1(jsonb_build_object('plate_number', 'VLP-100', 'vehicle_type_id', %L, 'branch_id', %L)) $q$,
      v_vehicle_type1,
      v_branch1
    ),
    '42501',
    NULL,
    'unprivileged tenant user cannot create vehicles'
  );

  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);

  v_create_result := public.create_vehicle_v1(jsonb_build_object(
    'plate_number', 'VLP-100',
    'vehicle_type_id', v_vehicle_type1,
    'branch_id', v_branch1,
    'vin', 'VLPVIN00000000001',
    'make', 'MasarX',
    'model', 'Live Van',
    'model_year', 2026,
    'metadata', jsonb_build_object('source', 'pgtap')
  ));
  v_vehicle_id := (v_create_result->>'vehicle_id')::UUID;

  RETURN NEXT ok(COALESCE((v_create_result->>'ok')::BOOLEAN, FALSE), 'create_vehicle_v1 returns ok');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicles v
       WHERE v.id = v_vehicle_id
         AND v.organization_id = v_org1
         AND v.plate_number = 'VLP-100'
         AND v.vehicle_type_id = v_vehicle_type1
         AND v.branch_id = v_branch1
    ),
    'create_vehicle_v1 inserts the canonical vehicles row'
  );

  PERFORM public.record_vehicle_event_v1(jsonb_build_object(
    'vehicle_id', v_vehicle_id,
    'event_type', 'fuel',
    'fuel_liters', 30,
    'odometer_km', 1234
  ));

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.v_vehicle_directory vd
       WHERE vd.id = v_vehicle_id
         AND vd.odometer_km = 1234
         AND vd.fuel_level = 0.5
         AND vd.last_telemetry_at IS NOT NULL
    ),
    'v_vehicle_directory projects telemetry from vehicle_events'
  );

  EXECUTE 'SET LOCAL ROLE authenticated';
  PERFORM set_config('request.jwt.claim.sub', v_unpriv1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  RETURN NEXT throws_ok(
    format(
      $q$ SELECT public.upload_vehicle_document_v1(jsonb_build_object('vehicle_id', %L, 'doc_type', 'registration', 'artifact_id', %L)) $q$,
      v_vehicle_id,
      v_artifact1
    ),
    '42501',
    NULL,
    'unprivileged tenant user cannot upload vehicle documents'
  );

  PERFORM set_config('request.jwt.claim.sub', v_admin1::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  v_upload_result := public.upload_vehicle_document_v1(jsonb_build_object(
    'vehicle_id', v_vehicle_id,
    'doc_type', 'registration',
    'issuer', 'Fleet Authority',
    'artifact_id', v_artifact1,
    'issued_at', '2026-01-01',
    'expires_at', '2027-01-01',
    'metadata', jsonb_build_object('source', 'pgtap')
  ));
  v_vehicle_document_id := (v_upload_result->>'vehicle_document_id')::UUID;

  RETURN NEXT ok(COALESCE((v_upload_result->>'ok')::BOOLEAN, FALSE), 'upload_vehicle_document_v1 returns ok');
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.vehicle_documents vd
       WHERE vd.id = v_vehicle_document_id
         AND vd.vehicle_id = v_vehicle_id
         AND vd.doc_type = 'registration'
         AND vd.status = 'submitted'
         AND vd.artifact_id = v_artifact1
    ),
    'upload_vehicle_document_v1 inserts vehicle_documents row'
  );
  RETURN NEXT ok(
    EXISTS (
      SELECT 1
        FROM public.artifact_links al
       WHERE al.artifact_id = v_artifact1
         AND al.resource_type = 'vehicle_document'
         AND al.resource_id = v_vehicle_document_id
         AND al.relation_type = 'source_document'
    ),
    'upload_vehicle_document_v1 links artifact to vehicle_document'
  );

  EXECUTE 'SET LOCAL ROLE postgres';
  RETURN;
END;
$function$;

SELECT * FROM test_vehicle_live_paths_v1();
SELECT * FROM finish();
ROLLBACK;
