-- pgTAP: Console V2 Driver Applications request-additional-docs controls are
-- backed by the canonical API-visible lookup catalog.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_function(
  'api',
  'list_lookup_values_v1',
  ARRAY['text'],
  'api.list_lookup_values_v1(text) exists for browser lookup hydration'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '5fd0bf0a-a066-49c1-95f8-08d82febcf31'::uuid,
  'Console V2 Driver Application Doc Lookup Org',
  'console-v2-driver-application-doc-lookup-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.users (
  id,
  organization_id,
  email,
  full_name,
  user_type,
  access_scope_type,
  access_scope_id,
  status
)
VALUES (
  'a2c1f780-8130-4ec9-9f65-cbc7a0b61f88'::uuid,
  '5fd0bf0a-a066-49c1-95f8-08d82febcf31'::uuid,
  'console-v2-driver-application-doc-lookups@example.test',
  'Console V2 Driver Application Doc Lookup Admin',
  'super_admin',
  'platform',
  NULL,
  'active'
)
ON CONFLICT (id) DO NOTHING;

SELECT set_config('request.jwt.claim.sub', 'a2c1f780-8130-4ec9-9f65-cbc7a0b61f88', true);
SELECT set_config(
  'request.jwt.claims',
  json_build_object(
    'sub', 'a2c1f780-8130-4ec9-9f65-cbc7a0b61f88',
    'role', 'authenticated',
    'email', 'console-v2-driver-application-doc-lookups@example.test'
  )::text,
  true
);
SET LOCAL ROLE authenticated;

SELECT is(
  (
    SELECT count(*)::int
      FROM api.list_lookup_values_v1('driver_application_doc_kind') AS row
     WHERE row.value IN ('license', 'national_id', 'medical', 'vehicle_inspection', 'insurance', 'hazmat_endorsement')
  ),
  6,
  'all driver application document kinds are API-visible'
);

SELECT is(
  (SELECT row.label FROM api.list_lookup_values_v1('driver_application_doc_kind') AS row WHERE row.value = 'medical'),
  'Medical certificate',
  'medical document kind resolves to operator label'
);

SELECT is(
  (SELECT row.is_default FROM api.list_lookup_values_v1('driver_application_doc_kind') AS row WHERE row.value = 'medical'),
  true,
  'medical remains the default requested document kind'
);

SELECT is(
  (SELECT row.metadata->>'tone' FROM api.list_lookup_values_v1('driver_application_doc_kind') AS row WHERE row.value = 'hazmat_endorsement'),
  'warn',
  'hazmat endorsement carries warning tone metadata'
);

RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_application_doc_kind'
       AND lv.value = 'license'
       AND lv.status = 'active'
  ),
  'canonical lookup_values contains active driver license document kind'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_application_doc_kind'
       AND lv.value = 'medical'
       AND lv.is_default
  ),
  'canonical lookup_values marks medical as default'
);

SELECT is(
  (
    SELECT count(*)::int
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'driver_application_doc_kind'
       AND lv.status = 'active'
  ),
  6,
  'canonical lookup_values contains exactly six active driver application document kinds'
);

SELECT * FROM finish();

ROLLBACK;
