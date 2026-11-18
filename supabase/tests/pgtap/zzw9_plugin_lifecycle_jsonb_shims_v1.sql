-- pgTAP: 4 plugin lifecycle jsonb-arg shim RPCs (W9-2)
-- Covers: plugin_submit_v1, plugin_approve_v1, plugin_activate_v1, plugin_set_binding_v1
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) Function existence (4 plans).
SELECT has_function(
  'public', 'plugin_submit_v1', ARRAY['jsonb'],
  'public.plugin_submit_v1(jsonb) exists'
);

SELECT has_function(
  'public', 'plugin_approve_v1', ARRAY['jsonb'],
  'public.plugin_approve_v1(jsonb) exists'
);

SELECT has_function(
  'public', 'plugin_activate_v1', ARRAY['jsonb'],
  'public.plugin_activate_v1(jsonb) exists'
);

SELECT has_function(
  'public', 'plugin_set_binding_v1', ARRAY['jsonb'],
  'public.plugin_set_binding_v1(jsonb) exists'
);

DO $$
DECLARE
  v_actor UUID := gen_random_uuid();
BEGIN
  PERFORM set_config('request.jwt.claim.sub', v_actor::text, true);
  PERFORM set_config(
    'request.jwt.claims',
    jsonb_build_object('sub', v_actor::text, 'role', 'authenticated')::text,
    true
  );
END $$;
SET LOCAL ROLE authenticated;

-- 2) Required-arg fail-closed (4 plans). All four shims raise 23502 when
-- their canonical key is missing.

-- plugin_submit_v1: requires plugin_version_id.
SELECT throws_ok(
  $$ SELECT public.plugin_submit_v1('{}'::jsonb) $$,
  '23502',
  NULL,
  'plugin_submit_v1 raises 23502 when plugin_version_id missing'
);

-- plugin_approve_v1: requires plugin_version_id.
SELECT throws_ok(
  $$ SELECT public.plugin_approve_v1('{}'::jsonb) $$,
  '23502',
  NULL,
  'plugin_approve_v1 raises 23502 when plugin_version_id missing'
);

-- plugin_activate_v1: requires plugin_version_id.
SELECT throws_ok(
  $$ SELECT public.plugin_activate_v1('{}'::jsonb) $$,
  '23502',
  NULL,
  'plugin_activate_v1 raises 23502 when plugin_version_id missing'
);

-- plugin_set_binding_v1: requires plugin_version_id and enabled.
SELECT throws_ok(
  $$ SELECT public.plugin_set_binding_v1(jsonb_build_object('plugin_version_id', gen_random_uuid())) $$,
  '23502',
  NULL,
  'plugin_set_binding_v1 raises 23502 when enabled missing'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
