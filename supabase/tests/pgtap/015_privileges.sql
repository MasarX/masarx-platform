-- Test Suite: Privilege denial for unauthorized roles

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- We will check that SELECT fails for the 'authenticated' role on protected tables.
SELECT plan(8);

-- Protect against errors if role doesn't exist (skip when not applicable)
-- Assume Supabase default roles exist.

-- webhook_inbox
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.webhook_inbox LIMIT 1 $$,
  '42501',
  'permission denied for table webhook_inbox'
);
RESET ROLE;

-- decision_log (response events live here)
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.decision_log LIMIT 1 $$,
  '42501',
  'permission denied for table decision_log'
);
RESET ROLE;

-- settings
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.settings LIMIT 1 $$,
  '42501',
  'permission denied for table settings'
);
RESET ROLE;

-- settings_versions
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.settings_versions LIMIT 1 $$,
  '42501',
  'permission denied for table settings_versions'
);
RESET ROLE;

-- api_route_packs (service-only)
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.api_route_packs LIMIT 1 $$,
  '42501',
  'permission denied for table api_route_packs'
);
RESET ROLE;

-- api_routes (service-only)
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.api_routes LIMIT 1 $$,
  '42501',
  'permission denied for table api_routes'
);
RESET ROLE;

-- provider_auth_configs (service-only secrets)
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT id FROM public.provider_auth_configs LIMIT 1 $$,
  '42501',
  'permission denied for table provider_auth_configs'
);
RESET ROLE;

-- storage.objects restricted buckets
SET LOCAL ROLE authenticated;
SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM storage.objects WHERE bucket_id IN ('labels','label-render-assets')
  ),
  'authenticated cannot read objects from private label buckets'
);
RESET ROLE;

SELECT finish();

ROLLBACK;


