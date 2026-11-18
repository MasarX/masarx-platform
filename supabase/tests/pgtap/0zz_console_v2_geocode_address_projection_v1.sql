BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SET search_path TO public, pgtap, extensions, pg_temp;

SELECT plan(17);

SELECT has_function(
  'public',
  'project_address_from_primary_geocode_v1',
  ARRAY['uuid'],
  'address projection helper exists'
);

SELECT function_privs_are(
  'public',
  'project_address_from_primary_geocode_v1',
  ARRAY['uuid'],
  'anon',
  ARRAY[]::text[],
  'address projection helper is not executable by anon'
);

SELECT function_privs_are(
  'public',
  'project_address_from_primary_geocode_v1',
  ARRAY['uuid'],
  'authenticated',
  ARRAY[]::text[],
  'address projection helper is not executable directly by authenticated users'
);

SELECT function_privs_are(
  'public',
  'project_address_from_primary_geocode_v1',
  ARRAY['uuid'],
  'service_role',
  ARRAY['EXECUTE'],
  'address projection helper is executable by service role workflows'
);

SELECT matches(
  pg_get_functiondef('workflow_handlers.execute_geocode_cache_v1(public.workflow_run_steps, public.workflow_runs, jsonb)'::regprocedure),
  'project_address_from_primary_geocode_v1',
  'geocode cache write wrapper projects the address after canonical cache writes'
);

SELECT matches(
  pg_get_functiondef('public.project_address_from_primary_geocode_v1(uuid)'::regprocedure),
  'resolve_settings\(''geocoding_policy''',
  'address projection resolves geocoding_policy instead of hardcoding confidence thresholds'
);

CREATE OR REPLACE FUNCTION pg_temp.exercise_console_v2_geocode_address_projection()
RETURNS SETOF text
LANGUAGE plpgsql
AS $function$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-000072450001';
  v_client UUID := '00000000-0000-0000-0000-000072450002';
  v_valid_address UUID := '00000000-0000-0000-0000-000072450003';
  v_review_address UUID := '00000000-0000-0000-0000-000072450004';
  v_provided_address UUID := '00000000-0000-0000-0000-000072450007';
  v_result JSONB;
  v_address RECORD;
BEGIN
  EXECUTE 'RESET ROLE';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Geocode Projection Org', 'console-v2-geocode-projection')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Geocode Projection Client', 'console-v2-geocode-projection-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id,
    organization_id,
    client_id,
    raw_input,
    normalized_line1,
    district,
    city,
    province,
    postal_code,
    country,
    validation_status
  )
  VALUES
    (
      v_valid_address,
      v_org,
      v_client,
      '{"line1":"Projection Tower","district":"Olaya","city":"Riyadh"}',
      'Projection Tower',
      'Olaya',
      'Riyadh',
      'Riyadh',
      '12212',
      'SA',
      'pending'
    ),
    (
      v_review_address,
      v_org,
      v_client,
      '{"line1":"Review Tower","district":"Unknown","city":"Riyadh"}',
      'Review Tower',
      'Unknown',
      'Riyadh',
      'Riyadh',
      '12212',
      'SA',
      'pending'
    ),
    (
      v_provided_address,
      v_org,
      v_client,
      '{"line1":"Pinned Tower","district":"Olaya","city":"Riyadh","latitude":24.7137,"longitude":46.6754,"coordinates":{"latitude":24.7137,"longitude":46.6754}}',
      'Pinned Tower',
      'Olaya',
      'Riyadh',
      'Riyadh',
      '12212',
      'SA',
      'pending'
    )
  ON CONFLICT (id, client_id) DO UPDATE
     SET validation_status = EXCLUDED.validation_status,
         coordinates = NULL;

  INSERT INTO public.geocodes (
    id,
    address_id,
    provider_name,
    coordinates,
    confidence_score,
    accuracy_type,
    formatted_address,
    metadata,
    is_primary,
    geocoded_at,
    expires_at,
    organization_id,
    client_id
  )
  VALUES
    (
      '00000000-0000-0000-0000-000072450005',
      v_valid_address,
      'canonical_lookup',
      ST_SetSRID(ST_MakePoint(46.6766, 24.7130), 4326)::geography,
      1.0,
      'district',
      'Olaya, Riyadh',
      '{"routing_reason":"local_match"}',
      TRUE,
      now(),
      now() + interval '1 day',
      v_org,
      v_client
    ),
    (
      '00000000-0000-0000-0000-000072450006',
      v_review_address,
      'canonical_lookup',
      ST_SetSRID(ST_MakePoint(46.6000, 24.7000), 4326)::geography,
      0.1,
      'district',
      'Unknown, Riyadh',
      '{"routing_reason":"low_confidence"}',
      TRUE,
      now(),
      now() + interval '1 day',
      v_org,
      v_client
    ),
    (
      '00000000-0000-0000-0000-000072450008',
      v_provided_address,
      'canonical_lookup',
      ST_SetSRID(ST_MakePoint(46.6766, 24.7130), 4326)::geography,
      1.0,
      'district',
      'Olaya, Riyadh',
      '{"routing_reason":"local_match"}',
      TRUE,
      now(),
      now() + interval '1 day',
      v_org,
      v_client
    )
  ON CONFLICT (id, address_id) DO UPDATE
     SET confidence_score = EXCLUDED.confidence_score,
         coordinates = EXCLUDED.coordinates,
         expires_at = EXCLUDED.expires_at,
         is_primary = EXCLUDED.is_primary;

  v_result := public.project_address_from_primary_geocode_v1(v_valid_address);
  SELECT validation_status, coordinates
    INTO v_address
    FROM public.addresses
   WHERE id = v_valid_address
     AND client_id = v_client;

  RETURN NEXT ok((v_result->>'projected')::BOOLEAN, 'projection helper returns projected=true for primary geocode');
  RETURN NEXT is(v_result->>'validation_status', 'valid', 'high-confidence primary geocode reports valid projection status');
  RETURN NEXT is(v_address.validation_status, 'valid', 'high-confidence primary geocode marks address valid');
  RETURN NEXT ok(v_address.coordinates IS NOT NULL, 'high-confidence primary geocode projects address coordinates');

  v_result := public.project_address_from_primary_geocode_v1(v_review_address);
  SELECT validation_status, coordinates
    INTO v_address
    FROM public.addresses
   WHERE id = v_review_address
     AND client_id = v_client;

  RETURN NEXT is(v_result->>'validation_status', 'requires_review', 'low-confidence primary geocode reports review projection status');
  RETURN NEXT is(v_address.validation_status, 'requires_review', 'low-confidence primary geocode keeps address in review state');
  RETURN NEXT ok(v_address.coordinates IS NOT NULL, 'low-confidence primary geocode still projects coordinates for inspection');

  v_result := public.project_address_from_primary_geocode_v1(v_provided_address);
  SELECT validation_status, coordinates
    INTO v_address
    FROM public.addresses
   WHERE id = v_provided_address
     AND client_id = v_client;

  RETURN NEXT is(v_result->>'coordinate_source', 'provided_coordinates', 'projection reports provided coordinates as canonical source when supplied');
  RETURN NEXT ok((v_result->>'provided_coordinates_preserved')::BOOLEAN, 'projection reports provided coordinates were preserved');
  RETURN NEXT is(round(ST_Y(v_address.coordinates::geometry)::numeric, 4), 24.7137::numeric, 'provided latitude survives primary-geocode projection');
  RETURN NEXT is(round(ST_X(v_address.coordinates::geometry)::numeric, 4), 46.6754::numeric, 'provided longitude survives primary-geocode projection');
END;
$function$;

SELECT * FROM pg_temp.exercise_console_v2_geocode_address_projection();

SELECT finish();

ROLLBACK;
