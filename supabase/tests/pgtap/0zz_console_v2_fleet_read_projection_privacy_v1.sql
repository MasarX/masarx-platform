BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

CREATE FUNCTION pg_temp.check_fleet_read_projection() RETURNS SETOF TEXT
LANGUAGE plpgsql AS $fixture$
DECLARE
  v_org UUID := gen_random_uuid();
  v_actor UUID := gen_random_uuid();
  v_driver UUID := gen_random_uuid();
  v_application UUID := gen_random_uuid();
  v_driver_row JSONB;
  v_application_row JSONB;
  v_document JSONB := '{"type":"license","ref":"synthetic-document","issued_at":"2026-01-01","expires_at":"2027-01-01","status":"submitted"}';
BEGIN
  INSERT INTO public.organizations (id, name, slug, billing_status)
  VALUES (v_org, 'Fleet projection fixture', 'fleet-projection-' || v_org, 'active');
  INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
  VALUES (v_actor, v_org, 'driver-' || v_actor || '@example.test', 'Synthetic driver', 'driver', 'active');
  INSERT INTO public.driver_profiles (id, organization_id, user_id, driver_code, status, metadata)
  VALUES (v_driver, v_org, v_actor, 'DRIVER-PROJECTION', 'active',
    jsonb_build_object('emergency_contact_name', 'Projection fixture contact', 'undisplayed', TRUE));
  INSERT INTO public.marketplace_participant_requests (
    id, status, requested_participant_type_key, requested_organization_id, email, full_name,
    organization_name, verification_documents, marketing, metadata, decision_metadata
  ) VALUES (
    v_application, 'pending', 'freelancer_driver', v_org, 'applicant-' || v_application || '@example.test',
    'Synthetic applicant', 'Fleet projection fixture', jsonb_build_array(v_document || '{"private_marker":"doc-private"}'),
    '{"utm_source":"synthetic-source","utm_campaign":"synthetic-campaign","private_marker":"marketing-private"}',
    '{"source":"synthetic-intake","private_marker":"application-private"}',
    '{"request_additional_docs":true,"requested_documents":["license",{"private_marker":"decision-private"}],"private_marker":"decision-private"}'
  );

  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);
  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  v_driver_row := public.ui_get_resource_v1('driver_directory', v_driver);
  v_application_row := public.ui_get_resource_v1('driver_application_directory', v_application);
  RETURN NEXT ok(v_driver_row IS NOT NULL AND NOT (v_driver_row ? 'metadata'),
    'driver directory read excludes raw profile metadata');
  RETURN NEXT is(v_driver_row->>'emergency_contact_name', 'Projection fixture contact',
    'driver directory retains the displayed emergency contact');
  RETURN NEXT ok(v_application_row IS NOT NULL AND NOT (v_application_row ?| ARRAY['metadata','marketing']),
    'driver application read excludes raw metadata and marketing');
  RETURN NEXT is(v_application_row->'verification_documents', jsonb_build_array(v_document),
    'driver application documents contain only the five displayed keys');
  RETURN NEXT is(v_application_row->>'utm_source', 'synthetic-source',
    'driver application retains the displayed UTM source');
  RETURN NEXT is(v_application_row->'decision_metadata',
    '{"request_additional_docs":true,"requested_documents":["license"]}'::jsonb,
    'driver application decision history excludes undisplayed fields and document objects');
END;
$fixture$;

SELECT * FROM pg_temp.check_fleet_read_projection();
SELECT * FROM finish();
ROLLBACK;
