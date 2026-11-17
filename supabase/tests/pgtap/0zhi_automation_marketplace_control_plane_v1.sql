-- Test Suite: automation marketplace control plane v1
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT no_plan();
SELECT has_column('public','provider_auth_configs','marketplace_explicit_only','durable explicit-only marker exists on runtime auth rows');

SELECT has_table('public', 'workflow_template_revisions', 'workflow_template_revisions table exists');
SELECT has_table('public', 'automation_asset_listings', 'automation_asset_listings table exists');
SELECT has_table('public', 'automation_asset_listing_versions', 'automation_asset_listing_versions table exists');
SELECT has_table('public', 'automation_asset_reviews', 'automation_asset_reviews table exists');
SELECT has_table('public', 'automation_asset_installs', 'automation_asset_installs table exists');
SELECT has_table('public', 'automation_asset_install_variables', 'automation_asset_install_variables table exists');
SELECT has_table('public', 'automation_asset_install_bindings', 'automation_asset_install_bindings table exists');
SELECT has_table('public', 'integration_connections', 'integration_connections table exists');
SELECT has_column('public','integration_connections','last_tested_credential_generation','local evidence is bound to a credential generation');
SELECT has_view('public','automation_asset_installs_read_v1','install readback derives eligible upgrade availability');
SELECT ok((SELECT 'security_invoker=true'=ANY(reloptions) FROM pg_class WHERE oid='public.automation_asset_installs_read_v1'::regclass),'upgrade read view preserves caller RLS');
SELECT ok(has_table_privilege('authenticated','public.automation_asset_installs_read_v1','SELECT') AND NOT has_table_privilege('authenticated','public.automation_asset_installs_read_v1','UPDATE'),'derived install read view adds no write grant');
SELECT ok(NOT has_table_privilege('anon','public.automation_asset_installs_read_v1','SELECT'),'derived availability is not anonymously readable');
SELECT is((SELECT count(*) FROM pg_trigger WHERE tgname='automation_marketplace_activation_guard' AND NOT tgisinternal),3::bigint,'later workflow/plugin/core/rollback activation is guarded at all three native transition tables');

SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'workflow_template_revisions'), 'RLS enabled on workflow_template_revisions');
SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'automation_asset_listings'), 'RLS enabled on automation_asset_listings');
SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'automation_asset_listing_versions'), 'RLS enabled on automation_asset_listing_versions');
SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'automation_asset_reviews'), 'RLS enabled on automation_asset_reviews');
SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'automation_asset_installs'), 'RLS enabled on automation_asset_installs');
SELECT ok((SELECT relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relname = 'integration_connections'), 'RLS enabled on integration_connections');

SELECT ok(EXISTS (SELECT 1 FROM public.settings_category_registry WHERE category = 'automation_marketplace_policy'), 'settings_category_registry includes automation_marketplace_policy');
SELECT ok(EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'automation_marketplace_policy' AND is_active = true), 'schema_registry includes automation_marketplace_policy');
SELECT ok(EXISTS (SELECT 1 FROM public.schema_registry WHERE category = 'automation_marketplace_manifest' AND is_active = true), 'schema_registry includes automation_marketplace_manifest');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'access_control_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND cached_value #>> '{resource_map,automation_asset_listings,read}' = 'automation_marketplace.read'
  ),
  'access_control_policy resource_map includes automation_asset_listings'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'access_control_policy'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'capabilities') AS cap
        WHERE cap->>'key' = 'automation_marketplace.manage_connections'
      )
  ),
  'access_control_policy includes automation marketplace capabilities'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS resource_entry
        WHERE resource_entry->>'key' = 'automation_asset_listings'
      )
  ),
  'ui_read_registry includes automation_asset_listings'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value->'resources') AS resource_entry
        WHERE resource_entry->>'key' = 'integration_connections'
      )
  ),
  'ui_read_registry includes integration_connections'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM public.settings
    CROSS JOIN LATERAL jsonb_array_elements(cached_value->'resources') AS resource_entry
    CROSS JOIN LATERAL jsonb_array_elements(COALESCE(resource_entry->'select', '[]'::jsonb)) AS select_entry
    WHERE category = 'ui_read_registry'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND resource_entry->>'key' = 'integration_connections'
      AND select_entry #>> '{}' IN ('credentials_vault_id', 'verifier_secret_hash')
  ),
  'integration_connections ui registry excludes secret storage columns'
);

SELECT has_function('public', 'automation_asset_create_listing_v1', ARRAY['text','uuid','text','text','text','jsonb','jsonb','jsonb','text','uuid'], 'automation_asset_create_listing_v1 exists');
SELECT has_function('public', 'automation_asset_install_v1', ARRAY['uuid','text','uuid','jsonb','jsonb','boolean'], 'automation_asset_install_v1 exists');
SELECT has_function('public', 'automation_asset_upgrade_apply_v1', ARRAY['uuid','uuid'], 'automation_asset_upgrade_apply_v1 exists');
SELECT has_function('public', 'integration_connection_upsert_v1', ARRAY['uuid','text','uuid','uuid','text','text','text','jsonb','jsonb','jsonb','jsonb','text','boolean','timestamp with time zone'], 'integration_connection_upsert_v1 exists');
SELECT has_function('public', 'integration_connection_bind_install_v1', ARRAY['uuid','text','uuid','text','jsonb'], 'integration_connection_bind_install_v1 exists');

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.settings
    WHERE category = 'ui_navigation'
      AND scope_type = 'global'
      AND scope_id IS NULL
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(cached_value #> '{apps,console,sections}') AS section_entry
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(section_entry->'items', '[]'::jsonb)) AS item_entry
        WHERE item_entry->>'href' = '/console/automation/marketplace'
      )
  ),
  'ui_navigation includes console automation marketplace route'
);

SELECT ok(NOT has_table_privilege('authenticated','public.automation_asset_listing_versions','INSERT,UPDATE,DELETE'),'table DML cannot bypass publication transitions');
SELECT ok(NOT has_column_privilege('authenticated','public.integration_connections','credentials_vault_id','SELECT'),'web role cannot select the Vault pointer');
SELECT ok(NOT has_column_privilege('authenticated','public.integration_connections','verifier_secret_hash','SELECT'),'web role cannot select verifier hashes');
SELECT ok(NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname IN ('public','api') AND p.proname='automation_asset_create_listing_v1' AND p.pronargs<>10),'only canonical ten-argument create contract exists');

SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='integration_connections'
 AND cmd='ALL' AND 'service_role'=ANY(roles)),'connection service policy is explicit without a table grant change');
SELECT ok(has_table_privilege('service_role','public.integration_connections','SELECT')
 AND NOT has_table_privilege('service_role','public.integration_connections','INSERT')
 AND NOT has_table_privilege('service_role','public.integration_connections','UPDATE')
 AND NOT has_table_privilege('service_role','public.integration_connections','DELETE'),
 'connection service table access remains SELECT-only despite the ALL policy');

WITH expected(table_name,updated_required) AS (VALUES
 ('workflow_template_revisions',FALSE),('automation_asset_listings',TRUE),('automation_asset_listing_versions',TRUE),
 ('automation_asset_reviews',TRUE),('automation_asset_installs',TRUE),('automation_asset_install_variables',TRUE),
 ('integration_connections',TRUE),('automation_asset_install_bindings',TRUE))
SELECT is((SELECT count(*) FROM expected e JOIN public.table_contracts c ON c.table_schema='public' AND c.table_name=e.table_name
 WHERE c.created_at_required AND c.updated_at_required=e.updated_required AND c.audit_enabled),8::bigint,
 'all eight core tables have intentional timestamp and meaningful audit contracts');
SELECT hasnt_column('public','workflow_template_revisions','updated_at','immutable revisions do not acquire a mutable update timestamp');
SELECT is((SELECT count(*) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace
 WHERE n.nspname='public' AND c.relname=ANY(ARRAY['workflow_template_revisions','automation_asset_listings',
 'automation_asset_listing_versions','automation_asset_reviews','automation_asset_installs','automation_asset_install_variables',
 'integration_connections','automation_asset_install_bindings']) AND t.tgname IN ('audit_row_change','audit_truncate_change')
 AND NOT t.tgisinternal),16::bigint,'all eight core tables have row and truncate audit triggers');
SELECT ok(to_regclass('public.idx_automation_asset_install_bindings_install') IS NULL
 AND to_regclass('public.idx_automation_asset_install_variables_install') IS NULL
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.automation_asset_install_bindings'::regclass AND conname='automation_asset_install_bindings_unique' AND contype='u')
 AND EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid='public.automation_asset_install_variables'::regclass AND conname='automation_asset_install_variables_unique' AND contype='u'),
 'duplicate standalone indexes are absent while binding and variable uniqueness remain enforced');

SELECT ok(COALESCE('security_invoker=true'=ANY(c.reloptions)
 AND has_table_privilege('authenticated',c.oid,'SELECT') AND has_table_privilege('service_role',c.oid,'SELECT')
 AND NOT has_table_privilege('anon',c.oid,'SELECT')
 AND NOT EXISTS(SELECT 1 FROM unnest(ARRAY['authenticated','service_role']) role_item(role_name)
  CROSS JOIN unnest(ARRAY['INSERT','UPDATE','DELETE']) privilege_item(privilege_key)
  WHERE has_table_privilege(role_item.role_name,c.oid,privilege_item.privilege_key)),FALSE),
 format('api.%s preserves caller RLS and SELECT-only privileges',names.table_name))
FROM unnest(ARRAY['workflow_template_revisions','automation_asset_listings','automation_asset_listing_versions',
 'automation_asset_reviews','automation_asset_installs','automation_asset_install_variables','automation_asset_install_bindings']) names(table_name)
LEFT JOIN pg_namespace n ON n.nspname='api'
LEFT JOIN pg_class c ON c.relnamespace=n.oid AND c.relname=names.table_name AND c.relkind='v';

WITH private_fields(table_name,columns) AS (VALUES
 ('workflow_template_revisions',ARRAY['snapshot','notes']),
 ('automation_asset_listings',ARRAY['title','summary','metadata']),
 ('automation_asset_listing_versions',ARRAY['manifest','snapshot_payload','docs','compatibility','egress_profile']),
 ('automation_asset_reviews',ARRAY['submission_notes','decision_notes','automated_checks','evidence']),
 ('automation_asset_installs',ARRAY['metadata']),('automation_asset_install_variables',ARRAY['value']),
 ('integration_connections',ARRAY['credentials_vault_id','verifier_secret_hash','secret_hint','runtime_auth_config_id','config','oauth_metadata','metadata']),
 ('automation_asset_install_bindings',ARRAY['config'])), probes AS (
 SELECT table_name,columns,public.audit_redact_row('public',table_name,
  (SELECT jsonb_object_agg(field.column_name,'synthetic-sensitive'::text) FROM unnest(columns) field(column_name))
   || jsonb_build_object('id','sg13-audit-probe','artifact_hash','safe-hash')) AS redacted
 FROM private_fields)
SELECT ok(redacted->>'id'='sg13-audit-probe' AND redacted->>'artifact_hash'='safe-hash'
 AND NOT EXISTS(SELECT 1 FROM unnest(columns) field(column_name) WHERE redacted->>field.column_name IS DISTINCT FROM '[REDACTED]'),
 format('%s audit rules redact payloads while retaining identity/hash evidence',table_name)) FROM probes;

CREATE TEMP TABLE sg13_audit_probe(org_id UUID,connection_id UUID);
INSERT INTO sg13_audit_probe VALUES(gen_random_uuid(),gen_random_uuid());
INSERT INTO public.organizations(id,name,slug,timezone,locale,billing_status,default_settings)
SELECT org_id,'SG13 audit','sg13-audit-'||org_id::text,'Asia/Riyadh','en','active','{}' FROM sg13_audit_probe;
INSERT INTO public.integration_connections(id,organization_id,owner_scope_type,owner_scope_id,provider_key,name,
 auth_type,status,secret_storage_mode,verifier_secret_hash,config)
SELECT connection_id,org_id,'tenant',org_id,'sg13_audit','SG13 audit','api_key','draft','hash_only',repeat('a',64),
 '{"display":"synthetic-sensitive"}' FROM sg13_audit_probe;
SELECT ok(EXISTS(SELECT 1 FROM public.audit_table_changes a JOIN sg13_audit_probe p ON a.pk->>'id'=p.connection_id::text
 WHERE a.schema_name='public' AND a.table_name='integration_connections' AND a.op='INSERT'
  AND a.row_new->>'verifier_secret_hash'='[REDACTED]' AND a.row_new->>'config'='[REDACTED]'
  AND a.row_new->>'organization_id'=p.org_id::text),'actual connection INSERT audit does not copy the verifier or config');
UPDATE public.integration_connections SET verifier_secret_hash=repeat('b',64) WHERE id=(SELECT connection_id FROM sg13_audit_probe);
SELECT ok(EXISTS(SELECT 1 FROM public.audit_table_changes a JOIN sg13_audit_probe p ON a.pk->>'id'=p.connection_id::text
 WHERE a.schema_name='public' AND a.table_name='integration_connections' AND a.op='UPDATE'
  AND a.row_old->>'verifier_secret_hash'='[REDACTED]' AND a.row_new->>'verifier_secret_hash'='[REDACTED]'
  AND a.row_old->>'config'='[REDACTED]' AND a.row_new->>'config'='[REDACTED]'),
 'actual connection UPDATE audit redacts both old and new credential/config snapshots');
SELECT * FROM finish();
ROLLBACK;
