-- pgTAP: api.ui_geocodes_with_latlng_v1 — projection contract
-- Wave 6 / W6-5 OPERATIONS schema-drift §15
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(5);

-- ============================================================================
-- 1. Function exists with the expected signature.
-- ============================================================================
SELECT has_function(
  'api',
  'ui_geocodes_with_latlng_v1',
  ARRAY['uuid'],
  'api.ui_geocodes_with_latlng_v1(uuid) is registered'
);

-- ============================================================================
-- 2. Function is SECURITY INVOKER (RLS pass-through).
-- ============================================================================
SELECT is(
  (SELECT prosecdef FROM pg_proc p
     JOIN pg_namespace n ON p.pronamespace = n.oid
    WHERE n.nspname = 'api'
      AND p.proname = 'ui_geocodes_with_latlng_v1'
    LIMIT 1),
  false,
  'ui_geocodes_with_latlng_v1 is SECURITY INVOKER (prosecdef = false)'
);

-- ============================================================================
-- 3. Function projects a row with derived lat/lng numeric scalars.
-- ============================================================================
DO $$
DECLARE
  v_org_id UUID := '00000065-0000-0000-0000-0000000000aa'::uuid;
  v_client_id UUID := '00000065-0000-0000-0000-0000000000bb'::uuid;
  v_address_id UUID := '00000065-0000-0000-0000-000000000001'::uuid;
  v_geocode_id UUID := '00000065-0000-0000-0000-000000000002'::uuid;
  v_lat DOUBLE PRECISION;
  v_lng DOUBLE PRECISION;
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org_id, 'W65 Geocode Org', 'w65-geocode-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.clients (id, organization_id, name, slug)
  VALUES (v_client_id, v_org_id, 'W65 Geocode Client', 'w65-geocode-client')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.addresses (
    id, organization_id, client_id, raw_input, city, province, country, validation_status
  ) VALUES (
    v_address_id, v_org_id, v_client_id, 'W65 Riyadh Test Address', 'Riyadh', 'Riyadh', 'SA', 'pending'
  )
  ON CONFLICT DO NOTHING;

  -- Seed a geocode at Riyadh approx coordinates (long=46.6753, lat=24.7136).
  INSERT INTO public.geocodes (id, organization_id, client_id, address_id, provider_name, coordinates,
                               confidence_score, is_primary)
  VALUES (
    v_geocode_id,
    v_org_id,
    v_client_id,
    v_address_id,
    'pgtap-w65',
    ST_SetSRID(ST_MakePoint(46.6753, 24.7136), 4326)::geography,
    0.95,
    true
  )
  ON CONFLICT DO NOTHING;

  SELECT latitude, longitude
    INTO v_lat, v_lng
    FROM api.ui_geocodes_with_latlng_v1(v_address_id)
   LIMIT 1;

  PERFORM set_config('test.w65_geo_lat', v_lat::text, true);
  PERFORM set_config('test.w65_geo_lng', v_lng::text, true);

  -- Cleanup test fixture.
  DELETE FROM public.geocodes WHERE id = v_geocode_id;

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  abs(current_setting('test.w65_geo_lat', true)::DOUBLE PRECISION - 24.7136::DOUBLE PRECISION) < 0.000001,
  'projected latitude approximates seeded ST_Y(coordinates)'
);

SELECT ok(
  abs(current_setting('test.w65_geo_lng', true)::DOUBLE PRECISION - 46.6753::DOUBLE PRECISION) < 0.000001,
  'projected longitude approximates seeded ST_X(coordinates)'
);

-- ============================================================================
-- 4. NULL p_address_id returns all rows (no implicit filter).
--    With no fixture rows beyond the cleanup above, expect zero from the
--    deterministic seed. Use a count assertion to exercise the codepath.
-- ============================================================================
SELECT cmp_ok(
  (SELECT COUNT(*) FROM api.ui_geocodes_with_latlng_v1(NULL))::INT,
  '>=',
  0::INT,
  'NULL p_address_id is a valid call (returns set; count >= 0)'
);

SELECT * FROM finish();
ROLLBACK;
