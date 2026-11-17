-- Plan: PLAN-202601-schema-audit-improvements / Step: S04
-- Test: Lookup column contracts enforce dynamic enums (no hardcoded CHECK IN)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

-- Fixtures (kept minimal; rolled back at end of file)
INSERT INTO public.organizations (id, name, slug)
VALUES (gen_random_uuid(), 'pgtap lookup contracts org', 'pgtap-lookup-contracts-' || left(gen_random_uuid()::text, 8))
ON CONFLICT DO NOTHING;

-- Reuse the most recently inserted org id inside this transaction.
-- (Using a deterministic fixture key avoids cross-test coupling in shared DBs.)
WITH org AS (
  SELECT id
  FROM public.organizations
  WHERE slug LIKE 'pgtap-lookup-contracts-%'
  ORDER BY created_at DESC
  LIMIT 1
)
INSERT INTO public.clients (id, organization_id, name, slug)
SELECT gen_random_uuid(), org.id, 'pgtap lookup contracts client', 'pgtap-lookup-contracts-client-' || left(gen_random_uuid()::text, 8)
FROM org
ON CONFLICT DO NOTHING;

WITH org AS (
  SELECT id
  FROM public.organizations
  WHERE slug LIKE 'pgtap-lookup-contracts-%'
  ORDER BY created_at DESC
  LIMIT 1
)
INSERT INTO public.mapping_configs (id, mapping_type, mapping_key, mapping_config)
SELECT gen_random_uuid(), 'webhook_inbound', 'pgtap-lookup-contracts::default', '{"field_mappings": {"example": "$.example"}}'::jsonb
FROM org
ON CONFLICT DO NOTHING;

WITH org AS (
  SELECT id
  FROM public.organizations
  WHERE slug LIKE 'pgtap-lookup-contracts-%'
  ORDER BY created_at DESC
  LIMIT 1
)
INSERT INTO public.label_template_specs (
  id,
  organization_id,
  template_key,
  template_scope_type,
  template_scope_id,
  renderer_config,
  asset_refs
)
SELECT
  gen_random_uuid(),
  org.id,
  'pgtap_lookup_contracts_template',
  'tenant',
  org.id,
  '{}'::jsonb,
  '[]'::jsonb
FROM org
ON CONFLICT DO NOTHING;

SELECT has_table('public', 'lookup_column_contracts', 'lookup_column_contracts exists');

SELECT ok(
  COALESCE(c.relrowsecurity, false),
  'RLS enabled on lookup_column_contracts'
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'lookup_column_contracts';

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'lookup_column_contracts'
      AND p.policyname = 'lookup_column_contracts_service_policy'
  ),
  'lookup_column_contracts has service_role policy'
);

SELECT ok(
  (
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'enforce_lookup_column_contracts'
    LIMIT 1
  ),
  'enforce_lookup_column_contracts is SECURITY DEFINER (no contract table privileges required)'
);

-- Guard: every contract category exists in lookup_definitions
WITH missing AS (
  SELECT DISTINCT lc.lookup_category
  FROM public.lookup_column_contracts lc
  LEFT JOIN public.lookup_definitions d
    ON d.category = lc.lookup_category
  WHERE d.id IS NULL
)
SELECT diag('Missing lookup_definitions category: ' || lookup_category)
FROM missing;

WITH missing AS (
  SELECT DISTINCT lc.lookup_category
  FROM public.lookup_column_contracts lc
  LEFT JOIN public.lookup_definitions d
    ON d.category = lc.lookup_category
  WHERE d.id IS NULL
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All lookup_column_contracts categories exist in lookup_definitions'
);

-- Smoke: contract enforcement rejects invalid values (feature_flags.scope_type)
SELECT throws_ok(
  $$
    INSERT INTO public.feature_flags (id, name, scope_type, enabled)
    VALUES (gen_random_uuid(), 'pgtap_invalid_scope_' || gen_random_uuid()::text, 'bogus_scope', false);
  $$,
  '23514',
  'Invalid lookup value for public.feature_flags.scope_type: "bogus_scope" is not an allowed value for category "feature_flag_scope"',
  'feature_flags.scope_type rejects invalid lookup value'
);

-- Smoke: contract enforcement rejects invalid values (shipments.status / shipments.service_type)
SELECT throws_ok(
  $$
    WITH org AS (
      SELECT id FROM public.organizations WHERE slug LIKE 'pgtap-lookup-contracts-%' ORDER BY created_at DESC LIMIT 1
    ),
    client AS (
      SELECT id, organization_id FROM public.clients WHERE slug LIKE 'pgtap-lookup-contracts-client-%' ORDER BY created_at DESC LIMIT 1
    )
    INSERT INTO public.shipments (id, organization_id, client_id, service_type, tracking_number, status)
    SELECT gen_random_uuid(), org.id, client.id, 'delivery', 'PGTAP-BOGUS-STATUS-' || left(gen_random_uuid()::text, 8), 'bogus_status'
    FROM org, client;
  $$,
  '23514',
  'Invalid lookup value for public.shipments.status: "bogus_status" is not an allowed value for category "shipment_status"',
  'shipments.status rejects invalid lookup value'
);

SELECT throws_ok(
  $$
    WITH org AS (
      SELECT id FROM public.organizations WHERE slug LIKE 'pgtap-lookup-contracts-%' ORDER BY created_at DESC LIMIT 1
    ),
    client AS (
      SELECT id, organization_id FROM public.clients WHERE slug LIKE 'pgtap-lookup-contracts-client-%' ORDER BY created_at DESC LIMIT 1
    )
    INSERT INTO public.shipments (id, organization_id, client_id, service_type, tracking_number, status)
    SELECT gen_random_uuid(), org.id, client.id, 'bogus_service_type', 'PGTAP-BOGUS-SVC-' || left(gen_random_uuid()::text, 8), 'created'
    FROM org, client;
  $$,
  '23514',
  'Invalid lookup value for public.shipments.service_type: "bogus_service_type" is not an allowed value for category "service_type"',
  'shipments.service_type rejects invalid lookup value'
);

-- Smoke: contract enforcement rejects invalid values (webhook_sources.provider_type -> integration_type)
SELECT throws_ok(
  $$
    WITH org AS (
      SELECT id FROM public.organizations WHERE slug LIKE 'pgtap-lookup-contracts-%' ORDER BY created_at DESC LIMIT 1
    ),
    mc AS (
      SELECT id FROM public.mapping_configs WHERE mapping_key = 'pgtap-lookup-contracts::default' ORDER BY created_at DESC LIMIT 1
    )
    INSERT INTO public.webhook_sources (
      id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled
    )
    SELECT
      gen_random_uuid(),
      org.id,
      'pgtap-lookup-contracts-source-' || left(gen_random_uuid()::text, 8),
      'pgtap lookup contracts source',
      'bogus_integration_type',
      'pgtap-token-' || left(gen_random_uuid()::text, 8),
      mc.id,
      TRUE
    FROM org, mc;
  $$,
  '23514',
  'Invalid lookup value for public.webhook_sources.provider_type: "bogus_integration_type" is not an allowed value for category "integration_type"',
  'webhook_sources.provider_type rejects invalid lookup value'
);

-- Smoke: contract enforcement rejects invalid values (label_jobs.status -> label_job_status)
SELECT throws_ok(
  $$
    WITH org AS (
      SELECT id FROM public.organizations WHERE slug LIKE 'pgtap-lookup-contracts-%' ORDER BY created_at DESC LIMIT 1
    ),
    client AS (
      SELECT id, organization_id FROM public.clients WHERE slug LIKE 'pgtap-lookup-contracts-client-%' ORDER BY created_at DESC LIMIT 1
    ),
    tpl AS (
      SELECT lts.id
      FROM public.label_template_specs lts
      JOIN org ON org.id = lts.organization_id
      WHERE lts.template_key = 'pgtap_lookup_contracts_template'
      ORDER BY lts.created_at DESC
      LIMIT 1
    )
    INSERT INTO public.label_jobs (
      id,
      organization_id,
      client_id,
      shipment_id,
      label_type,
      template_id,
      template_version,
      template_snapshot,
      status,
      attempts,
      max_attempts,
      scheduled_at,
      job_purpose,
      idempotency_key,
      requested_source
    )
    SELECT
      gen_random_uuid(),
      org.id,
      client.id,
      gen_random_uuid(),
      'shipping',
      tpl.id,
      1,
      '{}'::jsonb,
      'bogus_label_job_status',
      0,
      5,
      now(),
      'primary',
      'pgtap-idem-' || left(gen_random_uuid()::text, 8),
      'pgtap'
    FROM org, client, tpl;
  $$,
  '23514',
  'Invalid lookup value for public.label_jobs.status: "bogus_label_job_status" is not an allowed value for category "label_job_status"',
  'label_jobs.status rejects invalid lookup value'
);

-- Authenticated writes must not require direct access to contract tables.
CREATE TEMP TABLE tmp_lookup_contracts_auth_ctx AS
WITH org AS (
  SELECT id
  FROM public.organizations
  WHERE slug LIKE 'pgtap-lookup-contracts-%'
  ORDER BY created_at DESC
  LIMIT 1
)
SELECT
  org.id AS organization_id,
  gen_random_uuid() AS user_id
FROM org;

INSERT INTO public.users (id, organization_id, email, full_name, user_type, status)
SELECT
  user_id,
  organization_id,
  'pgtap-lookup-contracts-' || left(user_id::text, 8) || '@example.com',
  'pgTAP lookup contracts user',
  'ops_admin',
  'active'
FROM tmp_lookup_contracts_auth_ctx;

SELECT lives_ok(
  $$
    DO $do$
    DECLARE
      v_org UUID;
      v_user UUID;
    BEGIN
      SELECT organization_id, user_id INTO v_org, v_user
      FROM tmp_lookup_contracts_auth_ctx
      LIMIT 1;

      PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
      EXECUTE 'SET ROLE authenticated';

      INSERT INTO api.label_design_drafts (
        organization_id,
        scope_type,
        scope_id,
        label_type,
        draft_name,
        draft_value,
        status,
        created_by
      )
      VALUES (
        v_org,
        'tenant',
        v_org,
        'shipping',
        'pgTAP lookup contracts draft',
        '{}'::jsonb,
        'draft',
        v_user
      );

      EXECUTE 'RESET ROLE';
      PERFORM set_config('request.jwt.claim.sub', '', true);
    END
    $do$;
  $$,
  'authenticated can insert label_design_drafts without lookup contract privilege errors'
);

SELECT * FROM finish();

ROLLBACK;
