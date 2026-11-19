-- pgTAP: public.v_webhook_source_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W27 (paired projection views - INTEGRATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(9);

-- 1) View exists
SELECT has_view(
  'public', 'v_webhook_source_directory',
  'public.v_webhook_source_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_webhook_source_directory',
  ARRAY[
    'id', 'organization_id', 'source_identifier', 'name',
    'provider_type', 'mapping_config_id',
    'rate_limit_per_hour', 'enabled', 'created_at', 'updated_at',
    'mapping_label',
    'last_event_at', 'last_event_status',
    'event_count_24h', 'error_count_24h',
    'is_healthy', 'has_recent_errors',
    'auth_token_masked',
    'sender_id', 'client_id', 'sender_label', 'client_label',
    'hmac_enabled', 'hmac_header', 'hmac_algorithm',
    'hmac_signature_encoding', 'hmac_auth_config_id',
    'lifecycle_state', 'archived_at', 'archived_by',
    'archive_reason', 'managed_metadata'
  ],
  'v_webhook_source_directory exposes FE-projection columns'
);

-- 3) Projection must never expose raw source secrets.
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM pg_attribute a
      JOIN pg_class c ON c.oid = a.attrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'v_webhook_source_directory'
       AND a.attname IN ('auth_token', 'auth_token_hash')
       AND NOT a.attisdropped
  ),
  'v_webhook_source_directory does not expose raw webhook source token columns'
);

-- 4) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_webhook_source_directory', 'SELECT'),
  'service_role has SELECT on v_webhook_source_directory'
);

-- 5) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_webhook_source_directory', 'SELECT'),
  'anon has no SELECT on v_webhook_source_directory'
);

-- 6) authenticated has SELECT (registry-driven hooks read through this seam)
SELECT ok(
  has_table_privilege('authenticated', 'public.v_webhook_source_directory', 'SELECT'),
  'authenticated has SELECT on v_webhook_source_directory'
);

-- 7) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'webhook_sources'
       AND c.relkind = 'r'
  ),
  'public.webhook_sources remains a base table (SSOT preserved)'
);

-- 8) Projection: insert webhook source + mapping + successful inbox row.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000027a001';
  v_mapping  UUID := '00000000-0000-0000-0000-00000027a002';
  v_source   UUID := '00000000-0000-0000-0000-00000027a003';
  v_inbox    UUID := '00000000-0000-0000-0000-00000027a005';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 INT Org', 'w27-int-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id, mapping_type, mapping_key, mapping_config
  )
  VALUES (
    v_mapping, 'webhook_inbound',
    'w27-mc-main',
    jsonb_build_object('target', 'shipments.create')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_source, v_org,
    'w27-src-main',
    'W27 Source Name', 'shopify',
    'akiaw27authtokenmain',
    v_mapping, 1000, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (
    id, webhook_source_id, provider_type, external_id, event_type,
    raw_payload, processing_status, correlation_id, created_at
  )
  VALUES (
    v_inbox, v_source, 'shopify',
    'w27-ext-main',
    'shipment.created',
    jsonb_build_object('w27', TRUE),
    'succeeded',
    gen_random_uuid(),
    now() - INTERVAL '5 minutes'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT set_config('request.jwt.claim.role', 'service_role', true);
SELECT set_config('request.jwt.claims', jsonb_build_object('role', 'service_role')::text, true);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_webhook_source_directory
    WHERE id = '00000000-0000-0000-0000-00000027a003'::UUID
      AND event_count_24h = 1
      AND error_count_24h = 0
      AND is_healthy = TRUE
      AND has_recent_errors = FALSE
      AND auth_token_masked = 'stored'
      AND mapping_label = 'w27-mc-main'
      AND last_event_at IS NOT NULL
  ),
  'v_webhook_source_directory derives event_count_24h + error_count_24h + is_healthy + has_recent_errors + auth_token_masked + mapping_label + last_event_at'
);

-- 9) Failed-event projection.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000027a001';
  v_mapping  UUID := '00000000-0000-0000-0000-00000027a002';
  v_source2  UUID := '00000000-0000-0000-0000-00000027a013';
  v_inbox_f  UUID := '00000000-0000-0000-0000-00000027a014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_source2, v_org,
    'w27-src2-main',
    'W27 Source 2', 'shopify',
    'akiaw27tok2main',
    v_mapping, 1000, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (
    id, webhook_source_id, provider_type, external_id, event_type,
    raw_payload, processing_status, correlation_id, created_at, error_message
  )
  VALUES (
    v_inbox_f, v_source2, 'shopify',
    'w27-fail-main',
    'shipment.created',
    jsonb_build_object('failed', TRUE),
    'failed',
    gen_random_uuid(),
    now() - INTERVAL '10 minutes',
    'schema validation failed'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_webhook_source_directory
    WHERE id = '00000000-0000-0000-0000-00000027a013'::UUID
      AND error_count_24h = 1
      AND is_healthy = FALSE
      AND has_recent_errors = TRUE
      AND last_event_status = 'failed'
  ),
  'v_webhook_source_directory: failed inbox row drives error_count_24h + is_healthy=FALSE + has_recent_errors=TRUE + last_event_status=failed'
);

SELECT * FROM finish();
ROLLBACK;
