-- Test Suite: Webhook ingest policy ladder precedence

BEGIN;

SET LOCAL search_path TO public, extensions, pgtap, pg_temp;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

-- Seed org, client, sender, source
DO $$
DECLARE
  v_org UUID := 'aaaa5555-0000-0000-0000-000000005501';
  v_client UUID := 'bbbb5555-0000-0000-0000-000000005501';
  v_sender UUID := 'cccc5555-0000-0000-0000-000000005501';
  v_source UUID := 'dddd5555-0000-0000-0000-000000005501';
  v_mapping UUID := 'eeee5555-0000-0000-0000-000000005501';
BEGIN
  INSERT INTO organizations(id, name, slug) VALUES (v_org, 'Ladder Org', 'ladder-org')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO clients(id, organization_id, name, slug, sla_tier, status)
  VALUES (v_client, v_org, 'Ladder Client', 'ladder-client', 'standard', 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO senders(id, client_id, name, brand_name, auto_provisioned, status)
  VALUES (v_sender, v_client, 'Ladder Sender', 'Ladder', FALSE, 'active')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO mapping_configs(id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
  VALUES (v_mapping, 'webhook_inbound', 'ladder::default', '{}'::jsonb, 1, 'ladder test mapping')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO webhook_sources(
    id, organization_id, source_identifier, name, provider_type, auth_token, mapping_config_id, enabled, sender_id
  ) VALUES (
    v_source, v_org, 'ladder-source', 'Ladder Source', 'provider', 'ladder-token', v_mapping, TRUE, v_sender
  ) ON CONFLICT (id) DO NOTHING;
END$$;


-- Tenant override: synchronous_success (200)
SELECT ok(
  (
    SELECT upsert_webhook_ingest_policy('tenant', 'aaaa5555-0000-0000-0000-000000005501'::uuid, jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object('mode','synchronous_success','status_code',200)
    )) IS NOT NULL
  ),
  'Seeded tenant synchronous_success policy'
);

-- Sender override: synchronous_success (200)
SELECT ok(
  (
    SELECT upsert_webhook_ingest_policy('sender', 'cccc5555-0000-0000-0000-000000005501'::uuid, jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object('mode','synchronous_success','status_code',200)
    )) IS NOT NULL
  ),
  'Seeded sender synchronous_success policy'
);

-- Source override: accepted_async (202)
SELECT ok(
  (
    SELECT upsert_webhook_ingest_policy('source', 'dddd5555-0000-0000-0000-000000005501'::uuid, jsonb_build_object(
      'version', 1,
      'ack', jsonb_build_object('mode','accepted_async','status_code',202)
    )) IS NOT NULL
  ),
  'Seeded source accepted_async policy'
);

-- Expect resolution to select the most specific scope (source)
SELECT is(
  (
    SELECT scope_type FROM resolve_webhook_ingest_policy('dddd5555-0000-0000-0000-000000005501'::uuid)
  ),
  'source',
  'resolve_webhook_ingest_policy selects source scope when present'
);

SELECT * FROM finish();

ROLLBACK;
