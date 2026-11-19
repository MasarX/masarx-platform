-- pgTAP: public.v_mapping_config_directory projection contract (shape/RLS/projection)
-- Spec-Issue: W27 (paired projection views - INTEGRATIONS)
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(8);

-- 1) View exists
SELECT has_view(
  'public', 'v_mapping_config_directory',
  'public.v_mapping_config_directory view exists'
);

-- 2) View exposes the canonical FE-projection columns
SELECT columns_are(
  'public', 'v_mapping_config_directory',
  ARRAY[
    'id', 'organization_id', 'mapping_type', 'mapping_key', 'mapping_config',
    'mapping_version', 'notes', 'created_at', 'updated_at',
    'target', 'target_table', 'target_action', 'rules_count',
    'source_count', 'rule_usage_count', 'api_route_count',
    'is_in_use', 'has_rules',
    'notes_excerpt', 'age_seconds', 'managed_by', 'managed_metadata'
  ],
  'v_mapping_config_directory exposes FE-projection columns'
);

-- 3) Service-role baseline grant
SELECT ok(
  has_table_privilege('service_role', 'public.v_mapping_config_directory', 'SELECT'),
  'service_role has SELECT on v_mapping_config_directory'
);

-- 4) anon has no SELECT
SELECT ok(
  NOT has_table_privilege('anon', 'public.v_mapping_config_directory', 'SELECT'),
  'anon has no SELECT on v_mapping_config_directory'
);

-- 5) authenticated has SELECT
SELECT ok(
  has_table_privilege('authenticated', 'public.v_mapping_config_directory', 'SELECT'),
  'authenticated has SELECT on v_mapping_config_directory'
);

-- 6) Underlying base table remains SSOT
SELECT ok(
  EXISTS (
    SELECT 1
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname = 'mapping_configs'
       AND c.relkind = 'r'
  ),
  'public.mapping_configs remains a base table (SSOT preserved)'
);

-- 7) Projection: insert a mapping_config carrying target + rules[].
DO $$
DECLARE
  v_org      UUID := '00000000-0000-0000-0000-00000027c001';
  v_mapping  UUID := '00000000-0000-0000-0000-00000027c002';
  v_source   UUID := '00000000-0000-0000-0000-00000027c003';
  v_rule     UUID := '00000000-0000-0000-0000-00000027c004';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'W27 Mapping Org', 'w27-map-main')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id, mapping_type, mapping_key, mapping_config, notes
  )
  VALUES (
    v_mapping, 'webhook_inbound',
    'w27-mc-rules-main',
    jsonb_build_object(
      'target', 'shipments.create',
      'target_table', 'shipments',
      'target_action', 'create',
      'rules', jsonb_build_array(
        jsonb_build_object('from', 'sender_id', 'to', 'sender_id'),
        jsonb_build_object('from', 'tracking_number', 'to', 'tracking_number'),
        jsonb_build_object('from', 'destination', 'to', 'destination_address')
      )
    ),
    'W27 mapping notes - this mapping handles shipment intake from a webhook source.'
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_sources (
    id, organization_id, source_identifier, name, provider_type,
    auth_token, mapping_config_id, rate_limit_per_hour, enabled
  )
  VALUES (
    v_source, v_org,
    'w27-mc-src-main',
    'W27 Mapping-Use Source', 'shopify',
    'fixture-w27-mc-main-token',
    v_mapping, 1000, TRUE
  )
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.webhook_rules (
    id, webhook_source_id, event_type, name, priority,
    mapping_config_id, domain_category, enabled
  )
  VALUES (
    v_rule, v_source, 'shipment.created',
    'W27 Mapping-Use Rule', 10,
    v_mapping, 'shipment', TRUE
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_mapping_config_directory
    WHERE id = '00000000-0000-0000-0000-00000027c002'::UUID
      AND target = 'shipments.create'
      AND target_table = 'shipments'
      AND target_action = 'create'
      AND rules_count = 3
      AND source_count = 1
      AND rule_usage_count = 1
      AND api_route_count = 0
      AND is_in_use = TRUE
      AND has_rules = TRUE
      AND notes_excerpt LIKE 'W27 mapping notes%'
  ),
  'v_mapping_config_directory derives target + target_table + target_action + rules_count + source_count + rule_usage_count + api_route_count + is_in_use + has_rules + notes_excerpt'
);

-- 8) Unused mapping projection.
DO $$
DECLARE
  v_orphan UUID := '00000000-0000-0000-0000-00000027c014';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.mapping_configs (
    id, mapping_type, mapping_key, mapping_config
  )
  VALUES (
    v_orphan, 'event_extraction',
    'w27-mc-orphan-main',
    jsonb_build_object('target', 'events.emit')
  )
  ON CONFLICT (id) DO NOTHING;
END;
$$;

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.v_mapping_config_directory
    WHERE id = '00000000-0000-0000-0000-00000027c014'::UUID
      AND is_in_use = FALSE
      AND has_rules = FALSE
      AND source_count = 0
      AND rule_usage_count = 0
      AND api_route_count = 0
      AND rules_count = 0
      AND target = 'events.emit'
  ),
  'v_mapping_config_directory: orphan mapping resolves is_in_use=FALSE + has_rules=FALSE + source_count=0 + rule_usage_count=0 + api_route_count=0 + rules_count=0 (target still derives)'
);

SELECT * FROM finish();
ROLLBACK;
