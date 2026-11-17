-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S05

BEGIN;
SELECT plan(11);

-- Fixtures (minimal) - mirror patterns used across the suite
INSERT INTO public.organizations (id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000074', 'pgtap-org-074', 'pgtap-org-074')
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.clients (id, organization_id, name, slug)
VALUES ('00000000-0000-0000-0000-000000000174', '00000000-0000-0000-0000-000000000074', 'pgtap-client-074', 'pgtap-client-074')
ON CONFLICT (id) DO NOTHING;

-- Override policy at client scope to make test deterministic
INSERT INTO public.settings_versions (category, scope_type, scope_id, version, value, approved_at)
VALUES (
  'address_resolution_policy',
  'client',
  '00000000-0000-0000-0000-000000000174',
  1,
  jsonb_build_object(
    'version', 1,
    'fields', jsonb_build_array(
      jsonb_build_object(
        'name', 'normalized_line1',
        'sources', jsonb_build_array('short_code_reverse', 'test_input'),
        'fallback', 'latest_non_empty'
      ),
      jsonb_build_object(
        'name', 'sa_short_code',
        'sources', jsonb_build_array('test_input'),
        'fallback', 'latest_non_empty'
      )
    )
  ),
  now()
)
ON CONFLICT DO NOTHING;

-- Prime cache (settings table) to follow existing caching behavior
INSERT INTO public.settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT
  sv.category,
  sv.scope_type,
  sv.scope_id,
  sv.id,
  sv.value,
  now()
FROM public.settings_versions sv
WHERE sv.category = 'address_resolution_policy'
  AND sv.scope_type = 'client'
  AND sv.scope_id = '00000000-0000-0000-0000-000000000174'
ON CONFLICT (category, scope_type, scope_id)
DO UPDATE SET
  settings_version_id = EXCLUDED.settings_version_id,
  cached_value = EXCLUDED.cached_value,
  last_updated = EXCLUDED.last_updated;

-- Insert base address -> should append one version row
SELECT set_config('app.address_version_source', 'test_input', true);

INSERT INTO public.addresses (
  id,
  organization_id,
  client_id,
  raw_input,
  normalized_line1,
  validation_status,
  sa_short_code,
  city,
  province,
  country
)
VALUES (
  '00000000-0000-0000-0000-000000000274',
  '00000000-0000-0000-0000-000000000074',
  '00000000-0000-0000-0000-000000000174',
  'TEST0000',
  'line-a',
  'pending',
  'TEST0000',
  'Example City',
  'Example City',
  'SA'
);

SELECT is(
  (SELECT count(*)::int FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000274'),
  1,
  'INSERT into addresses appends one address_versions row'
);

SELECT is(
  (SELECT source_type FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000274' ORDER BY created_at DESC LIMIT 1),
  'test_input',
  'address_versions.source_type honors app.address_version_source'
);

SELECT is(
  (SELECT payload->>'normalized_line1' FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000274' ORDER BY created_at DESC LIMIT 1),
  'line-a',
  'version payload captures normalized_line1'
);

-- Update with different source; policy should prefer short_code_reverse over test_input
SELECT set_config('app.address_version_source', 'short_code_reverse', true);

UPDATE public.addresses
SET normalized_line1 = 'line-b'
WHERE id = '00000000-0000-0000-0000-000000000274'
  AND client_id = '00000000-0000-0000-0000-000000000174';

SELECT is(
  (SELECT count(*)::int FROM public.address_versions WHERE address_id = '00000000-0000-0000-0000-000000000274'),
  2,
  'UPDATE into addresses appends a second address_versions row'
);

SELECT is(
  (
    SELECT source_type
    FROM public.address_versions
    WHERE address_id = '00000000-0000-0000-0000-000000000274'
      AND payload->>'normalized_line1' = 'line-b'
    LIMIT 1
  ),
  'short_code_reverse',
  'update version row source_type is short_code_reverse'
);

-- Effective projection: addresses.normalized_line1 should now reflect line-b
SELECT is(
  (SELECT normalized_line1 FROM public.addresses WHERE id = '00000000-0000-0000-0000-000000000274' AND client_id = '00000000-0000-0000-0000-000000000174'),
  'line-b',
  'policy-driven effective projection updates addresses.normalized_line1'
);

-- Effective should keep sa_short_code from test_input (only source configured)
SELECT is(
  (SELECT sa_short_code FROM public.addresses WHERE id = '00000000-0000-0000-0000-000000000274' AND client_id = '00000000-0000-0000-0000-000000000174'),
  'TEST0000',
  'effective projection keeps sa_short_code from original source'
);

-- Resolver returns policy + provenance
SELECT ok(
  (public.resolve_address_effective_v1('00000000-0000-0000-0000-000000000274', '00000000-0000-0000-0000-000000000174', 'client', '00000000-0000-0000-0000-000000000174') ? 'policy'),
  'resolve_address_effective_v1 returns policy metadata'
);

SELECT ok(
  (public.resolve_address_effective_v1('00000000-0000-0000-0000-000000000274', '00000000-0000-0000-0000-000000000174', 'client', '00000000-0000-0000-0000-000000000174') ? 'provenance'),
  'resolve_address_effective_v1 returns provenance'
);

-- Settings resolution log should get at least one row (trigger logs every run)
SELECT ok(
  (SELECT count(*) FROM public.settings_resolution_log WHERE organization_id = '00000000-0000-0000-0000-000000000074' AND category = 'address_resolution_policy') >= 1,
  'settings_resolution_log has at least one entry for address_resolution_policy'
);

-- Decision log should record address_resolution decisions
SELECT ok(
  (SELECT count(*) FROM public.decision_log WHERE organization_id = '00000000-0000-0000-0000-000000000074' AND decision_category = 'address_resolution') >= 1,
  'decision_log has at least one address_resolution entry'
);

SELECT * FROM finish();
ROLLBACK;
