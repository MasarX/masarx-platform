-- pgTAP: Console V2 geocodes registry exposes map-ready lat/lng projection.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(12);

SELECT has_view(
  'api',
  'geocodes',
  'api.geocodes exists for Console V2 map reads'
);

SELECT ok(
  COALESCE((
    SELECT c.reloptions @> ARRAY['security_invoker=true']
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'api'
       AND c.relname = 'geocodes'
  ), FALSE),
  'api.geocodes is a security_invoker view'
);

SELECT ok(
  has_table_privilege('authenticated', 'api.geocodes', 'SELECT')
    AND has_table_privilege('service_role', 'api.geocodes', 'SELECT')
    AND NOT has_table_privilege('anon', 'api.geocodes', 'SELECT'),
  'api.geocodes grants SELECT to authenticated/service_role only'
);

SELECT columns_are(
  'api',
  'geocodes',
  ARRAY[
    'id',
    'organization_id',
    'client_id',
    'address_id',
    'provider_name',
    'latitude',
    'longitude',
    'lat',
    'lng',
    'confidence_score',
    'accuracy_type',
    'formatted_address',
    'metadata',
    'is_primary',
    'geocoded_at',
    'expires_at',
    'created_at',
    'updated_at',
    'map_rank'
  ],
  'api.geocodes exposes canonical scope columns plus scalar map coordinates'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000002010a1';
  v_client UUID := '00000000-0000-0000-0000-0000002010b1';
  v_address UUID := '00000000-0000-0000-0000-0000002010c1';
  v_geocode UUID := '00000000-0000-0000-0000-0000002010d1';
  v_user UUID := '00000000-0000-0000-0000-0000002010e1';
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Geocode Projection Org', 'console-v2-geocode-projection-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Geocode Projection Client', 'console-v2-geocode-projection-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province, country, validation_status
  )
  VALUES (
    v_address, v_org, v_client, 'Console V2 geocode projection address', 'Riyadh', 'Riyadh', 'SA', 'pending'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.geocodes (
    id, organization_id, client_id, address_id, provider_name, coordinates,
    confidence_score, accuracy_type, formatted_address, is_primary
  )
  VALUES (
    v_geocode,
    v_org,
    v_client,
    v_address,
    'pgtap-console-v2',
    ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
    0.97,
    'rooftop',
    'Console V2 geocode projection address, Riyadh',
    TRUE
  )
  ON CONFLICT DO NOTHING;

  SELECT lat, lng
    INTO v_lat, v_lng
    FROM api.geocodes
   WHERE id = v_geocode;

  PERFORM set_config('test.console_v2_geocode_lat', v_lat::TEXT, TRUE);
  PERFORM set_config('test.console_v2_geocode_lng', v_lng::TEXT, TRUE);

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-geocode-projection@example.test',
    'Console V2 Geocode Projection Admin',
    'super_admin',
    'platform',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user,
      'role', 'authenticated',
      'email', 'console-v2-geocode-projection@example.test'
    )::TEXT,
    TRUE
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_list_resource_v1(
           'geocodes',
           jsonb_build_object('address_id', v_address),
           5,
           0,
           NULL::jsonb
         )
    INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM set_config(
    'test.console_v2_geocode_api_lat',
    COALESCE(v_result#>>'{items,0,lat}', ''),
    TRUE
  );
  PERFORM set_config(
    'test.console_v2_geocode_api_lng',
    COALESCE(v_result#>>'{items,0,lng}', ''),
    TRUE
  );
  PERFORM set_config(
    'test.console_v2_geocode_api_relation_keys',
    COALESCE((v_result->'keys')::TEXT, '[]'),
    TRUE
  );

  EXECUTE 'SET LOCAL ROLE postgres';
END;
$$;

SELECT ok(
  abs(current_setting('test.console_v2_geocode_lat', TRUE)::DOUBLE PRECISION - 24.7136::DOUBLE PRECISION) < 0.000001,
  'view lat alias projects ST_Y(coordinates)'
);

SELECT ok(
  abs(current_setting('test.console_v2_geocode_lng', TRUE)::DOUBLE PRECISION - 46.6753::DOUBLE PRECISION) < 0.000001,
  'view lng alias projects ST_X(coordinates)'
);

SELECT is(
  (
    SELECT resource.value->>'relation'
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL::uuid)->'resources') AS resource(value)
     WHERE resource.value->>'key' = 'geocodes'
     LIMIT 1
  ),
  'api.geocodes',
  'ui_read_registry routes geocodes to the api-schema map-ready projection'
);

SELECT ok(
  (
    SELECT resource.value->'scope_columns' = jsonb_build_object(
             'tenant', 'organization_id',
             'client', 'client_id'
           )
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL::uuid)->'resources') AS resource(value)
     WHERE resource.value->>'key' = 'geocodes'
     LIMIT 1
  ),
  'geocodes registry scope columns match projection columns and do not advertise missing sender_id'
);

SELECT is(
  (
    SELECT resource.value#>>'{default_sort,column}'
      FROM jsonb_array_elements(public.resolve_settings_merged('ui_read_registry', 'platform', NULL::uuid)->'resources') AS resource(value)
     WHERE resource.value->>'key' = 'geocodes'
     LIMIT 1
  ),
  'map_rank',
  'geocodes registry default sort uses canonical primary/freshness rank for map consumers'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.settings s
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.cached_value->'resources', '[]'::jsonb)) AS resource(value)
     WHERE s.category = 'ui_read_registry'
       AND resource.value->>'key' = 'geocodes'
       AND resource.value->>'relation' = 'public.geocodes'
  ),
  'no active ui_read_registry geocodes row remains bound to raw public.geocodes'
);

SELECT ok(
  abs(current_setting('test.console_v2_geocode_api_lat', TRUE)::DOUBLE PRECISION - 24.7136::DOUBLE PRECISION) < 0.000001
    AND abs(current_setting('test.console_v2_geocode_api_lng', TRUE)::DOUBLE PRECISION - 46.6753::DOUBLE PRECISION) < 0.000001,
  'api.ui_list_resource_v1 returns geocodes with scalar lat/lng for browser map consumers'
);

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-0000002010a2';
  v_client UUID := '00000000-0000-0000-0000-0000002010b2';
  v_address UUID := '00000000-0000-0000-0000-0000002010c2';
  v_primary UUID := '00000000-0000-0000-0000-0000002010d2';
  v_user UUID := '00000000-0000-0000-0000-0000002010e2';
  v_result JSONB;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Geocode Rank Org', 'console-v2-geocode-rank-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug, status)
  VALUES (v_client, v_org, 'Console V2 Geocode Rank Client', 'console-v2-geocode-rank-client', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province, country, validation_status
  )
  VALUES (
    v_address, v_org, v_client, 'Console V2 geocode rank address', 'Riyadh', 'Riyadh', 'SA', 'pending'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.geocodes (
    id, organization_id, client_id, address_id, provider_name, coordinates,
    confidence_score, accuracy_type, formatted_address, is_primary, geocoded_at, expires_at
  )
  SELECT
    ('00000000-0000-0000-0000-0000002011' || lpad(i::TEXT, 2, '0'))::UUID,
    v_org,
    v_client,
    v_address,
    'newer-non-primary-' || i,
    ST_SetSRID(ST_MakePoint(46.0 + i::DOUBLE PRECISION / 1000, 24.0 + i::DOUBLE PRECISION / 1000), 4326)::geography,
    0.99,
    'interpolated',
    'newer non-primary geocode',
    FALSE,
    now() - (i || ' minutes')::INTERVAL,
    now() + INTERVAL '7 days'
  FROM generate_series(1, 6) AS i
  ON CONFLICT DO NOTHING;

  INSERT INTO public.geocodes (
    id, organization_id, client_id, address_id, provider_name, coordinates,
    confidence_score, accuracy_type, formatted_address, is_primary, geocoded_at, expires_at
  )
  VALUES (
    v_primary,
    v_org,
    v_client,
    v_address,
    'older-primary',
    ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
    0.8,
    'rooftop',
    'older primary geocode',
    TRUE,
    now() - INTERVAL '30 days',
    now() + INTERVAL '30 days'
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status
  )
  VALUES (
    v_user,
    v_org,
    'console-v2-geocode-rank@example.test',
    'Console V2 Geocode Rank Admin',
    'super_admin',
    'platform',
    NULL,
    'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('request.jwt.claim.sub', v_user::TEXT, TRUE);
  PERFORM set_config(
    'request.jwt.claims',
    json_build_object(
      'sub', v_user,
      'role', 'authenticated',
      'email', 'console-v2-geocode-rank@example.test'
    )::TEXT,
    TRUE
  );

  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_list_resource_v1(
           'geocodes',
           jsonb_build_object('address_id', v_address),
           5,
           0,
           NULL::jsonb
         )
    INTO v_result;

  EXECUTE 'RESET ROLE';

  PERFORM set_config('test.console_v2_geocode_rank_first_id', COALESCE(v_result#>>'{items,0,id}', ''), TRUE);

  EXECUTE 'SET LOCAL ROLE postgres';
END;
$$;

SELECT is(
  current_setting('test.console_v2_geocode_rank_first_id', TRUE),
  '00000000-0000-0000-0000-0000002010d2',
  'api.ui_list_resource_v1 returns older primary non-expired geocode before newer non-primary alternatives'
);

SELECT * FROM finish();

ROLLBACK;
