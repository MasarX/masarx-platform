-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S05

BEGIN;
SELECT plan(4);

INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000075', 'pgtap-org-075', 'pgtap-org-075')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000175', '00000000-0000-0000-0000-000000000075', 'pgtap-client-075', 'pgtap-client-075')
ON CONFLICT (id) DO NOTHING;

-- Create an address (will append first version)
SELECT set_config('app.address_version_source', 'test_input', true);

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  normalized_line1,
  validation_status,
  city,
  province,
  country
)
VALUES (
  '00000000-0000-0000-0000-000000000275',
  '00000000-0000-0000-0000-000000000075',
  '00000000-0000-0000-0000-000000000175',
  'raw-imm',
  'line-imm',
  'pending',
  'Riyadh',
  'Riyadh',
  'SA'
);

SELECT ok(
  (SELECT count(*) FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000275') >= 1,
  'address_versions created for new address'
);

-- Attempt UPDATE should fail (append-only)
SELECT throws_ok(
  $$UPDATE public.address_versions SET source_type = 'mutate' WHERE address_id = '00000000-0000-0000-0000-000000000275';$$,
  '2F003',
  'address_versions is append-only (immutable); use a new version row instead'
);

-- Attempt DELETE should fail (append-only)
SELECT throws_ok(
  $$DELETE FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000275';$$,
  '2F003',
  'address_versions is append-only (immutable); use a new version row instead'
);

-- apply_address_patch_v1 appends version without duplicating via trigger
SELECT ok(
  (public.apply_address_patch_v1(
    '00000000-0000-0000-0000-000000000275',
    '00000000-0000-0000-0000-000000000175',
    '00000000-0000-0000-0000-000000000075',
    'short_code_reverse',
    jsonb_build_object('normalized_line1','line-imm-2'),
    'pgtap',
    'client',
    '00000000-0000-0000-0000-000000000175'
  )) ? 'effective',
  'apply_address_patch_v1 returns a resolution payload'
);

SELECT * FROM finish();
ROLLBACK;
