-- Test Suite: Mobile attestation policy + ingest enforcement foundation
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(18);

SELECT has_function(
  'public',
  'resolve_mobile_attestation_policy',
  ARRAY['jsonb'],
  'resolve_mobile_attestation_policy exists'
);

SELECT has_function(
  'public',
  'issue_mobile_attestation_challenge_v1',
  ARRAY['jsonb'],
  'issue_mobile_attestation_challenge_v1 exists'
);

SELECT has_function(
  'public',
  'assert_mobile_attestation_for_ingest_v1',
  ARRAY['text', 'uuid', 'uuid', 'uuid', 'uuid', 'jsonb'],
  'assert_mobile_attestation_for_ingest_v1 exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings_category_registry
    WHERE category = 'mobile_attestation_policy'
      AND requires_schema
      AND requires_global_default
      AND safe_missing_behavior = 'hard_fail'
  ),
  'mobile_attestation_policy category registered with hard-fail semantics'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.schema_registry
    WHERE category = 'mobile_attestation_policy'
      AND version = 1
      AND is_active
      AND schema->'properties' ? 'mode'
      AND schema->'properties' ? 'enforce_rpcs'
      AND schema->'properties' ? 'allowed_providers'
      AND schema->'properties' ? 'max_age_seconds'
      AND schema->'properties' ? 'challenge_ttl_seconds'
      AND schema->'properties' ? 'allow_background_without_attestation'
  ),
  'mobile_attestation_policy schema v1 includes enforcement fields'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'mobile_attestation_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value->>'mode' = 'off'
      AND COALESCE((cached_value->>'enabled')::boolean, FALSE) = FALSE
  ),
  'mobile_attestation_policy global cache defaults to disabled/off'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.resolve_mobile_attestation_policy(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute resolve_mobile_attestation_policy'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.resolve_mobile_attestation_policy(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute resolve_mobile_attestation_policy'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'public.issue_mobile_attestation_challenge_v1(jsonb)',
    'EXECUTE'
  ),
  'authenticated can execute issue_mobile_attestation_challenge_v1'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'public.issue_mobile_attestation_challenge_v1(jsonb)',
    'EXECUTE'
  ),
  'anon cannot execute issue_mobile_attestation_challenge_v1'
);

SELECT has_table(
  'public',
  'mobile_attestation_challenges',
  'mobile_attestation_challenges table exists'
);

SELECT has_table(
  'public',
  'mobile_attestation_events',
  'mobile_attestation_events table exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'mobile_attestation_challenges'
      AND c.relrowsecurity
  ),
  'mobile_attestation_challenges has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'mobile_attestation_events'
      AND c.relrowsecurity
  ),
  'mobile_attestation_events has RLS enabled'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'user_devices'
      AND t.tgname = 'trg_mobile_attestation_user_devices_v1'
      AND NOT t.tgisinternal
  ),
  'user_devices attestation trigger exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'location_pings'
      AND t.tgname = 'trg_mobile_attestation_location_pings_v1'
      AND NOT t.tgisinternal
  ),
  'location_pings attestation trigger exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'scan_events'
      AND t.tgname = 'trg_mobile_attestation_scan_events_v1'
      AND NOT t.tgisinternal
  ),
  'scan_events attestation trigger exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class c ON c.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'ops_sessions'
      AND t.tgname = 'trg_mobile_attestation_ops_sessions_v1'
      AND NOT t.tgisinternal
  ),
  'ops_sessions attestation trigger exists'
);

SELECT finish();

ROLLBACK;
