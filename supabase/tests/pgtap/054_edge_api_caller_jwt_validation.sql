-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S95
-- Purpose: Regression test for resolve_edge_api_caller_jwt_v1() JWT validation.

BEGIN;

SELECT plan(2);

SELECT ok(
  (SELECT id IS NOT NULL FROM public.providers WHERE name = 'edge_api_caller' LIMIT 1),
  'edge_api_caller provider exists'
);

-- Insert a fresh shared_secret so the resolver picks it up (created_at desc).
WITH auth AS (
  SELECT gen_random_uuid() AS auth_config_id, p.id AS provider_id
  FROM public.providers p
  WHERE p.name = 'edge_api_caller'
  LIMIT 1
),
secret AS (
  SELECT
    auth.auth_config_id,
    auth.provider_id,
    vault.create_secret(
      '{"shared_secret":"a.b.c"}',
      'provider_auth_configs/' || auth.auth_config_id::text,
      'pgtap edge_api_caller shared_secret jwt validation',
      NULL
    ) AS vault_id
  FROM auth
)
INSERT INTO public.provider_auth_configs (id, provider_id, auth_type, credentials_vault_id, credentials, expires_at)
SELECT
  secret.auth_config_id,
  secret.provider_id,
  'shared_secret',
  secret.vault_id,
  NULL,
  NULL
FROM secret;

SELECT is(
  public.resolve_edge_api_caller_jwt_v1(),
  'a.b.c',
  'resolve_edge_api_caller_jwt_v1 returns latest JWT-like shared_secret'
);

SELECT * FROM finish();

ROLLBACK;
