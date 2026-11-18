-- pgTAP: Console V2 webhook source references must remain stable operator
-- keys for receiver/tester/idempotency workflows.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_sources'::regclass
       AND conname = 'webhook_sources_source_identifier_operator_key'
       AND pg_get_constraintdef(oid) LIKE '%source_identifier%'
  ),
  'webhook_sources enforces source_identifier operator-key shape for new writes'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conrelid = 'public.webhook_sources'::regclass
       AND conname = 'webhook_sources_source_identifier_operator_key'
       AND convalidated IS TRUE
  ),
  'webhook_sources operator-key constraint validates existing data'
);

INSERT INTO public.organizations (id, name, slug)
VALUES (
  '0d5c1c28-9bb6-45be-90f2-a3b81a6d86b0'::uuid,
  'Console V2 Webhook Source Key Org',
  'console-v2-webhook-source-key-org'
)
ON CONFLICT (id) DO NOTHING;

INSERT INTO public.mapping_configs (
  id,
  mapping_type,
  mapping_key,
  mapping_config,
  mapping_version,
  notes
)
VALUES (
  'b0ab78d9-bb2f-493a-9b79-393dfad39a47'::uuid,
  'webhook_inbound',
  'console-v2-webhook-source-key-test',
  '{"target":"shipments.create","rules":[]}'::jsonb,
  1,
  'Console V2 webhook source operator key test mapping'
)
ON CONFLICT (mapping_type, mapping_key) DO UPDATE
SET mapping_config = EXCLUDED.mapping_config,
    updated_at = now();

SELECT lives_ok(
  $$
    INSERT INTO public.webhook_sources (
      id,
      organization_id,
      source_identifier,
      name,
      provider_type,
      auth_token,
      mapping_config_id,
      rate_limit_per_hour,
      enabled
    )
    VALUES (
      '31c7b712-bac9-4a08-9f45-5cf38df7ab80'::uuid,
      '0d5c1c28-9bb6-45be-90f2-a3b81a6d86b0'::uuid,
      'source-1000',
      'Console V2 Valid Source Key',
      'generic',
      'console-v2-valid-source-key-token',
      'b0ab78d9-bb2f-493a-9b79-393dfad39a47'::uuid,
      1000,
      true
    )
  $$,
  'valid source references may include letters and numbers'
);

SELECT throws_ok(
  $$
    INSERT INTO public.webhook_sources (
      id,
      organization_id,
      source_identifier,
      name,
      provider_type,
      auth_token,
      mapping_config_id,
      rate_limit_per_hour,
      enabled
    )
    VALUES (
      'e3cc4de3-a4a3-42dd-a2f9-030a524d55a0'::uuid,
      '0d5c1c28-9bb6-45be-90f2-a3b81a6d86b0'::uuid,
      '1000',
      'Console V2 Numeric Source Key',
      'generic',
      'console-v2-numeric-source-key-token',
      'b0ab78d9-bb2f-493a-9b79-393dfad39a47'::uuid,
      1000,
      true
    )
  $$,
  '23514',
  'new row for relation "webhook_sources" violates check constraint "webhook_sources_source_identifier_operator_key"',
  'numeric-only source references are rejected'
);

SELECT throws_ok(
  $$
    INSERT INTO public.webhook_sources (
      id,
      organization_id,
      source_identifier,
      name,
      provider_type,
      auth_token,
      mapping_config_id,
      rate_limit_per_hour,
      enabled
    )
    VALUES (
      '4ee11666-5c60-4321-8a2d-c315d6634fd2'::uuid,
      '0d5c1c28-9bb6-45be-90f2-a3b81a6d86b0'::uuid,
      'source with spaces',
      'Console V2 Spaced Source Key',
      'generic',
      'console-v2-spaced-source-key-token',
      'b0ab78d9-bb2f-493a-9b79-393dfad39a47'::uuid,
      1000,
      true
    )
  $$,
  '23514',
  'new row for relation "webhook_sources" violates check constraint "webhook_sources_source_identifier_operator_key"',
  'source references reject whitespace and remain URL-safe'
);

SELECT * FROM finish();

ROLLBACK;
