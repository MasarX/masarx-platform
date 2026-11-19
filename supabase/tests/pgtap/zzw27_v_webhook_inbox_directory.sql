-- pgTAP: public.v_webhook_inbox_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W27 (paired projection views - INTEGRATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_webhook_inbox_directory',
  'public.v_webhook_inbox_directory view exists'
);

-- 2) View exposes at least the canonical FE-projection columns. Later
-- lifecycle slices may add workflow/mapping/materialization fields; those
-- additions should not break the base inbox directory contract.
WITH required_columns(column_name) AS (
  SELECT unnest(ARRAY[
    'id', 'webhook_source_id', 'provider_type', 'external_id',
    'event_type', 'processing_status', 'correlation_id',
    'lease_expires_at', 'created_at', 'processed_at', 'error_message',
    'payload_size',
    'source_label', 'source_identifier', 'provider_type_label',
    'replay_count', 'force_status_count',
    'last_replay_at', 'last_replay_action', 'last_replay_actor',
    'is_terminal', 'is_actionable',
    'age_seconds', 'age_hours'
  ]::text[])
)
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM required_columns required
     WHERE NOT EXISTS (
       SELECT 1
         FROM information_schema.columns cols
        WHERE cols.table_schema = 'public'
          AND cols.table_name = 'v_webhook_inbox_directory'
          AND cols.column_name = required.column_name
     )
  ),
  'v_webhook_inbox_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_webhook_inbox_directory', 'SELECT'),
  'service_role has SELECT on v_webhook_inbox_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_webhook_inbox_directory', 'SELECT'),
  'anon has no SELECT on v_webhook_inbox_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_webhook_inbox_directory', 'SELECT'),
  'authenticated has SELECT on v_webhook_inbox_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'webhook_inbox'
       AND c.relkind = 'r'
  ),
  'public.webhook_inbox remains a base table (SSOT preserved)'
);

-- 7) Projection: insert source + inbox + replay ledger entries.
DO $$
DECLARE
  v_org       UUID := '00000000-0000-0000-0000-00000027b001';
  v_mapping   UUID := '00000000-0000-0000-0000-00000027b002';
  v_source    UUID := '00000000-0000-0000-0000-00000027b003';
  v_inbox     UUID := '00000000-0000-0000-0000-00000027b004';
  v_replay1   UUID := '00000000-0000-0000-0000-00000027b005';
  v_replay2   UUID := '00000000-0000-0000-0000-00000027b006';
  v_user      UUID := '00000000-0000-0000-0000-00000027b007';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Inbox Org', 'w27-ibx-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (
    id, organization_id, email, full_name, user_type, status
  )
  VALUES (
    v_user, v_org,
    'w27-ibx-u-main@example.com',
    'W27 Inbox Operator', 'ops_admin', 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id, mapping_type, mapping_key, mapping_config
  )
  VALUES (
    v_mapping, 'webhook_inbound',
    'w27-mc-ibx-main',
    jsonb_build_object('target', 'shipments.create')
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_source, v_org,
    'w27-ibx-src-main',
    'W27 Inbox Source', 'shopify',
    'akiaw27ibxmain',
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
    jsonb_build_object('a', 1, 'b', 'two', 'c', ARRAY[1, 2, 3]),
    'failed',
    gen_random_uuid(),
    now() - INTERVAL '90 seconds'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox_replays (
    id, webhook_inbox_id, organization_id, webhook_source_id,
    action, prior_status, forced_status, reason, changed_by, created_at
  )
  VALUES
    (v_replay1, v_inbox, v_org, v_source, 'replay',
      'failed', NULL, 'operator_replay', v_user,
      now() - INTERVAL '60 seconds'),
    (v_replay2, v_inbox, v_org, v_source, 'force_status',
      'failed', 'failed', 'operator_force_failed', v_user,
      now() - INTERVAL '30 seconds')
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_webhook_inbox_directory
    WHERE id = '00000000-0000-0000-0000-00000027b004'::UUID
      AND source_label = 'W27 Inbox Source'
      AND source_identifier = 'w27-ibx-src-main'
      AND payload_size > 10
      AND replay_count = 1
      AND force_status_count = 1
      AND last_replay_action = 'force_status'
      AND last_replay_actor = 'W27 Inbox Operator'
      AND is_actionable = TRUE
      AND age_seconds >= 25
  ),
  'v_webhook_inbox_directory derives source_label + source_identifier + payload_size + replay_count + force_status_count + last_replay_action + last_replay_actor + is_actionable + age_seconds'
);

-- 8) Terminal-status projection.
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000027b001';
  v_source2  UUID := '00000000-0000-0000-0000-00000027b013';
  v_mapping  UUID := '00000000-0000-0000-0000-00000027b002';
  v_inbox_ok UUID := '00000000-0000-0000-0000-00000027b014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_source2, v_org,
    'w27-ibx-src2-main',
    'W27 Inbox Source 2', 'shopify',
    'akiaw27ibx2main',
    v_mapping, 1000, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_inbox (
    id, webhook_source_id, provider_type, external_id, event_type,
    raw_payload, processing_status, correlation_id, created_at
  )
  VALUES (
    v_inbox_ok, v_source2, 'shopify',
    'w27-ok-main',
    'shipment.created',
    jsonb_build_object('ok', TRUE),
    'succeeded',
    gen_random_uuid(),
    now() - INTERVAL '5 minutes'
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_webhook_inbox_directory
    WHERE id = '00000000-0000-0000-0000-00000027b014'::UUID
      AND is_terminal = TRUE
      AND is_actionable = FALSE
      AND replay_count = 0
  ),
  'v_webhook_inbox_directory: succeeded row resolves is_terminal=TRUE + is_actionable=FALSE + replay_count=0'
);

SELECT * FROM finish();
ROLLBACK;
