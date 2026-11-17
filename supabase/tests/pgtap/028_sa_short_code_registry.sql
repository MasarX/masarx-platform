-- Test Suite: Saudi short national address short-code SSOT registry

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(9);

SET search_path TO public, pgtap, extensions;

-- 1) addresses.sa_short_code exists
SELECT has_column('public', 'addresses', 'sa_short_code', 'addresses.sa_short_code exists');

-- 2) Format constraint exists (ABCD1234, uppercase)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'addresses_sa_short_code_format_check'
      AND conrelid = 'public.addresses'::regclass
  ),
  'addresses_sa_short_code_format_check exists'
);

-- 3) address_code_registry has RLS enabled
SELECT ok(
  (SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='address_code_registry'),
  'RLS enabled on address_code_registry'
);

-- 4) address_code_registry has service_role policy
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname='public'
      AND tablename='address_code_registry'
      AND roles @> ARRAY['service_role'::name]
  ),
  'address_code_registry has a service_role policy'
);

-- 5) authenticated cannot SELECT from address_code_registry
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.address_code_registry LIMIT 1 $$,
  '42501',
  'permission denied for table address_code_registry'
);
RESET ROLE;

-- 6) authenticated cannot INSERT into address_code_registry
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ INSERT INTO public.address_code_registry (country_code, code_type, code_value, coordinates)
     VALUES ('SA','sa_short_code','ABCD1234', ST_SetSRID(ST_MakePoint(46.7,24.7),4326)::geography) $$,
  '42501',
  'permission denied for table address_code_registry'
);
RESET ROLE;

-- 7) HERE forward template supports country filter + type narrowing (in/types)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.operation_templates ot
    WHERE ot.operation_name = 'geocoding_here_forward_v1'
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(ot.metadata->'url_query_mapping', '[]'::jsonb)) elem
        WHERE elem->>'param' = 'in'
          AND elem->>'value_path' = '$.address.in'
      )
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(ot.metadata->'url_query_mapping', '[]'::jsonb)) elem
        WHERE elem->>'param' = 'types'
          AND elem->>'value_path' = '$.address.types'
      )
  ),
  'HERE forward url_query_mapping includes in/types'
);

-- 8) HERE provider_response mapping supports province fallback (state -> county)
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.mapping_configs mc
    WHERE mc.mapping_type = 'provider_response'
      AND mc.mapping_key = 'geocoding::here_forward::v1'
      AND mc.mapping_config->'field_mappings'->'province' = jsonb_build_array('$.items[0].address.state', '$.items[0].address.county')
  ),
  'HERE provider_response mapping sets province as [state, county] fallback'
);

-- 9) Global geocoding_policy short_code plugin has registry_ttl_minutes, HERE hints, and reverse toggle
SELECT ok(
  EXISTS (
    WITH latest AS (
      SELECT sv.value AS policy
      FROM public.settings_versions sv
      WHERE sv.category = 'geocoding_policy'
        AND sv.scope_type = 'global'
      ORDER BY sv.version DESC
      LIMIT 1
    )
    SELECT 1
    FROM latest
    JOIN LATERAL jsonb_array_elements(COALESCE(latest.policy->'matching_plugins','[]'::jsonb)) elem ON TRUE
    WHERE lower(elem->>'name') = 'short_code'
      AND (elem->'params' ? 'registry_ttl_minutes')
      AND (elem->'params' ? 'here_in')
      AND (elem->'params' ? 'here_types')
      AND (elem->'params' ? 'reverse_geocode_on_hit')
  ),
  'short_code plugin params include registry_ttl_minutes + here_in + here_types + reverse_geocode_on_hit'
);

SELECT finish();

ROLLBACK;
