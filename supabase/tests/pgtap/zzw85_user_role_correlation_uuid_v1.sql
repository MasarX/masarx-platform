-- pgTAP: Console V2 user-role mutation correlation ids are UUID-native.
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

SELECT has_function(
  'public',
  'grant_user_role_v1',
  ARRAY['jsonb'],
  'public.grant_user_role_v1(jsonb) is registered'
);

SELECT has_function(
  'public',
  'revoke_user_role_v1',
  ARRAY['jsonb'],
  'public.revoke_user_role_v1(jsonb) is registered'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.grant_user_role_v1(jsonb)')) ~
    'v_correlation_id\s+UUID\s*:=\s*gen_random_uuid\(\)',
  'grant_user_role_v1 uses gen_random_uuid for correlation id'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.revoke_user_role_v1(jsonb)')) ~
    'v_correlation_id\s+UUID\s*:=\s*gen_random_uuid\(\)',
  'revoke_user_role_v1 uses gen_random_uuid for correlation id'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.grant_user_role_v1(jsonb)')) !~
    'encode\(gen_random_bytes\(8\), ''hex''\)|v_correlation_id::uuid',
  'grant_user_role_v1 does not cast a short hex token to uuid'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.revoke_user_role_v1(jsonb)')) !~
    'encode\(gen_random_bytes\(8\), ''hex''\)|v_correlation_id::uuid',
  'revoke_user_role_v1 does not cast a short hex token to uuid'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.grant_user_role_v1(jsonb)')) ~
    'assert_capability_v1\(\s*''users\.manage''\s*\)',
  'grant_user_role_v1 remains users.manage-gated'
);

SELECT ok(
  pg_get_functiondef(to_regprocedure('public.revoke_user_role_v1(jsonb)')) ~
    'assert_capability_v1\(\s*''users\.manage''\s*\)',
  'revoke_user_role_v1 remains users.manage-gated'
);

SELECT * FROM finish();
ROLLBACK;
