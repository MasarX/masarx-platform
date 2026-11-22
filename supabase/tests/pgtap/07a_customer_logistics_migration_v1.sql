-- Test: customer/logistics migration canonical import and workflow contract
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(69);

SELECT has_table('public', 'logistics_migration_sources', 'migration sources table exists');
SELECT has_table('public', 'logistics_migration_profiles', 'migration profiles table exists');
SELECT has_table('public', 'logistics_migration_requests', 'migration import extension table exists');
SELECT has_table('public', 'logistics_migration_items', 'migration item lineage table exists');
SELECT col_is_pk('public', 'logistics_migration_requests', 'import_job_id', 'import_job_id is the extension primary key');

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name = 'logistics_migration_requests'
       AND column_name IN ('status', 'mode', 'started_at', 'completed_at', 'error_summary')
  ),
  'logistics extension has no competing lifecycle columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON kcu.constraint_catalog = tc.constraint_catalog
       AND kcu.constraint_schema = tc.constraint_schema
       AND kcu.constraint_name = tc.constraint_name
      JOIN information_schema.constraint_column_usage ccu
        ON ccu.constraint_catalog = tc.constraint_catalog
       AND ccu.constraint_schema = tc.constraint_schema
       AND ccu.constraint_name = tc.constraint_name
     WHERE tc.table_schema = 'public'
       AND tc.table_name = 'logistics_migration_requests'
       AND tc.constraint_type = 'FOREIGN KEY'
       AND kcu.column_name = 'import_job_id'
       AND ccu.table_schema = 'public'
       AND ccu.table_name = 'import_jobs'
       AND ccu.column_name = 'id'
  ),
  'logistics extension is a strict import_jobs child'
);

SELECT has_function('public', 'validate_logistics_customer_migration_profile_v1', ARRAY['jsonb','jsonb'], 'profile contract validator exists');
SELECT has_function('public', 'safe_jsonpath_query_array_v1', ARRAY['jsonb','text','integer'], 'deterministic collection JSONPath helper exists');
SELECT has_function('public', 'apply_logistics_customer_migration_profile_v1', ARRAY['jsonb','jsonb','integer'], 'profile mapping executor exists');
SELECT has_function('public', 'validate_logistics_customer_migration_mapped_v1', ARRAY['jsonb','jsonb'], 'mapped payload validator exists');
SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM (VALUES
        ('public.safe_jsonpath_query_array_v1(jsonb,text,integer)'),
        ('public.validate_logistics_customer_migration_profile_v1(jsonb,jsonb)'),
        ('public.apply_logistics_customer_migration_profile_v1(jsonb,jsonb,integer)'),
        ('public.validate_logistics_customer_migration_mapped_v1(jsonb,jsonb)')
      ) AS helper(signature)
     WHERE has_function_privilege('anon', helper.signature, 'EXECUTE')
  ),
  'anonymous callers cannot execute migration helpers'
);
SELECT has_function('workflow_handlers', 'execute_logistics_customer_migration_v1', ARRAY['workflow_run_steps','workflow_runs','jsonb'], 'workflow handler exists');
SELECT has_function('public', 'ui_upsert_logistics_customer_migration_config_v1', ARRAY['jsonb'], 'Console migration config RPC exists');
SELECT has_function('public', 'ui_execute_logistics_customer_migration_v1', ARRAY['jsonb'], 'Console migration execution RPC exists');
SELECT has_function('api', 'ui_upsert_logistics_customer_migration_config_v1', ARRAY['jsonb'], 'API migration config wrapper exists');
SELECT has_function('api', 'ui_execute_logistics_customer_migration_v1', ARRAY['jsonb'], 'API migration execution wrapper exists');

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.operation_handlers
     WHERE handler_key = 'logistics_customer_migration'
       AND handler_schema = 'workflow_handlers'
       AND handler_name = 'execute_logistics_customer_migration_v1'
       AND handler_signature = '(workflow_run_steps,workflow_runs,jsonb)'
       AND is_active
  ),
  'canonical workflow handler is registered'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_templates wt
      JOIN public.workflow_template_steps wts ON wts.workflow_template_id = wt.id
     WHERE wt.name = 'customer_logistics_migration_v1'
       AND wt.status = 'active'
       AND wts.sequence_order = 1
       AND wts.handler_key = 'logistics_customer_migration'
       AND wts.enabled
  ),
  'customer migration template has a real enabled handler step'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.onboarding_integration_plugin_defaults
     WHERE profile_key = 'default'
       AND scope_type = 'tenant'
       AND plugin_key = 'customer-logistics-migration'
       AND plugin_kind = 'api'
       AND required
       AND activation_mode = 'auto_activate'
       AND enabled
  ),
  'canonical onboarding profile requires the stable api plugin'
);

SELECT ok(
  pg_get_functiondef('public.ui_upsert_logistics_customer_migration_config_v1(jsonb)'::regprocedure)
    ILIKE ALL (ARRAY[
      '%integration_plugins.write%',
      '%integration_plugins.test%',
      '%integration_plugins.approve%',
      '%integration_plugins.activate%',
      '%bootstrap_integration_plugin_defaults_v1%',
      '%audit_log.read%',
      '%onboarding_integration_plugin_readiness_v1%',
      '%canonical_onboarding_readiness_blocked%'
    ]),
  'config path enforces every canonical plugin lifecycle gate'
);

SELECT ok(
  pg_get_functiondef('public.ui_upsert_logistics_customer_migration_config_v1(jsonb)'::regprocedure)
    NOT ILIKE '%INSERT INTO public.integration_plugins%'
  AND pg_get_functiondef('public.ui_upsert_logistics_customer_migration_config_v1(jsonb)'::regprocedure)
    NOT ILIKE '%INSERT INTO public.integration_plugin_versions%'
  AND pg_get_functiondef('public.ui_upsert_logistics_customer_migration_config_v1(jsonb)'::regprocedure)
    NOT ILIKE '%SET active_version_id%',
  'config path never fabricates active plugin lifecycle state'
);

SELECT ok(
  pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%import_job_create_v1%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%public.progress_workflow_run%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%profile_config_sha256%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%onboarding_integration_plugin_readiness_v1%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%audit_log.read%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%workflows.read%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%workflow_progress_failed%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    ILIKE '%workflow_progress_not_terminal%'
  AND pg_get_functiondef('public.ui_execute_logistics_customer_migration_v1(jsonb)'::regprocedure)
    NOT ILIKE '%UPDATE public.workflow_runs%',
  'execution uses import SSOT and public workflow progress without direct terminal updates'
);

SELECT ok(
  pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%apply_logistics_customer_migration_profile_v1%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%client_create_v1%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%recipient_create_v1%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%workflow_engine_context_required%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%workflow_engine_lineage_mismatch%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%FROM public.workflow_runs%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%v_runtime_run.context%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%max_payload_bytes%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%onboarding_integration_plugin_readiness_v1%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    ILIKE '%canonical onboarding readiness blocked%'
  AND pg_get_functiondef('workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)'::regprocedure)
    NOT ILIKE '%UPDATE public.workflow_runs%',
  'handler requires canonical engine lineage and executes stored rules and product RPCs only'
);

SELECT ok(
  pg_get_functiondef('public.apply_logistics_customer_migration_profile_v1(jsonb,jsonb,integer)'::regprocedure)
    ILIKE '%safe_jsonpath_query_array_v1%'
  AND pg_get_functiondef('public.apply_logistics_customer_migration_profile_v1(jsonb,jsonb,integer)'::regprocedure)
    NOT ILIKE '%FROM jsonb_path_query(%',
  'collection mapping is delegated to the deterministic fail-closed helper'
);

SELECT ok(
  NOT has_function_privilege(
    'anon',
    'workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)',
    'EXECUTE'
  )
  AND NOT has_function_privilege(
    'authenticated',
    'workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)',
    'EXECUTE'
  )
  AND has_function_privilege(
    'service_role',
    'workflow_handlers.execute_logistics_customer_migration_v1(workflow_run_steps,workflow_runs,jsonb)',
    'EXECUTE'
  ),
  'workflow handler is callable only through trusted engine or service execution'
);

SELECT is(
  public.safe_jsonpath_query_array_v1(
    '{"contacts":[{"id":"one"},{"id":"two"}]}'::jsonb,
    '$.contacts',
    2
  ),
  '[{"id":"one"},{"id":"two"}]'::jsonb,
  'collection helper deterministically flattens one array result'
);

SELECT throws_ok(
  $$SELECT public.safe_jsonpath_query_array_v1('{"contacts":[]}'::jsonb, '$.contacts[', 2)$$,
  '22023',
  'safe_jsonpath_query_array_v1 invalid JSONPath',
  'invalid collection JSONPath fails closed'
);

SELECT throws_ok(
  $$SELECT public.safe_jsonpath_query_array_v1('{"contacts":["bad"]}'::jsonb, '$.contacts[*]', 2)$$,
  '22023',
  'safe_jsonpath_query_array_v1 collection items must be objects',
  'non-object collection items fail closed'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public'
       AND table_name IN ('logistics_migration_requests', 'logistics_migration_items')
       AND column_name IN ('payload', 'raw_payload', 'secret', 'token', 'password', 'api_key')
  ),
  'migration evidence tables do not persist raw payload or secret columns'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.settings s
      JOIN public.settings_versions sv ON sv.id = s.settings_version_id
     WHERE s.category = 'ui_read_registry'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(COALESCE(sv.value->'resources', '[]'::jsonb)) resource
          WHERE resource->>'key' = 'logistics_migration_requests'
            AND resource->>'relation' = 'public.v_logistics_migration_request_directory'
            AND resource->>'capability_read' = 'imports.read'
            AND resource->>'capability_write' = 'imports.write'
       )
  ),
  'migration lifecycle readback is capability-gated by imports SSOT'
);

DO $setup$
DECLARE
  v_org UUID := '00000000-0000-4000-8000-000000071001';
  v_actor UUID := '00000000-0000-4000-8000-000000071002';
  v_other_org UUID := '00000000-0000-4000-8000-000000071003';
  v_other_actor UUID := '00000000-0000-4000-8000-000000071004';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';
  INSERT INTO public.organizations (id, name, slug)
  VALUES
    (v_org, 'Example Migration Organization', 'example-migration-organization'),
    (v_other_org, 'Example Second Organization', 'example-migration-second-organization')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id, status)
  VALUES (
    v_actor, v_org, 'user-b9acde88@example.invalid',
    'Example Migration Operator', 'ops_admin', 'tenant', NULL, 'active'
  ), (
    v_other_actor, v_other_org, 'other-operator@example.invalid',
    'Example Second Operator', 'ops_admin', 'tenant', NULL, 'active'
  )
  ON CONFLICT (id) DO NOTHING;

  PERFORM set_config('test.migration_actor', v_actor::text, true);
  PERFORM set_config('test.migration_org', v_org::text, true);
  PERFORM set_config('test.migration_other_actor', v_other_actor::text, true);
  EXECUTE 'RESET ROLE';
END;
$setup$;

SELECT set_config('request.jwt.claim.sub', current_setting('test.migration_actor'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.migration_actor'), 'role', 'authenticated')::text,
  true
);

SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.migration_mapping',
  jsonb_build_object(
    'version', 1,
    'objects', jsonb_build_object(
      'client', jsonb_build_object(
        'source_path', '$.account',
        'field_mappings', jsonb_build_object(
          'name', '$.display_name',
          'slug', '$.client_code',
          'sla_tier', '$.service_tier'
        )
      )
    ),
    'collections', jsonb_build_object(
      'recipients', jsonb_build_object(
        'source_path', '$.contacts[*]',
        'field_mappings', jsonb_build_object(
          'external_id', '$.legacy_ref',
          'name', '$.full_name',
          'phone_number', '$.mobile',
          'email', '$.mail',
          'preferred_language', '$.language'
        )
      )
    )
  )::text,
  true
);

SELECT set_config(
  'test.migration_validation',
  jsonb_build_object(
    'version', 1,
    'required_paths', jsonb_build_array('$.client.name', '$.client.slug'),
    'required_collections', jsonb_build_array(jsonb_build_object(
      'path', '$.recipients',
      'min_items', 1,
      'required_fields', jsonb_build_array('name', 'phone_number')
    )),
    'limits', jsonb_build_object(
      'max_recipients', 2,
      'max_payload_bytes', 262144
    ),
    'conflict_policy', jsonb_build_object(
      'client_slug', 'fail',
      'recipient_external_id', 'fail',
      'recipient_phone_number', 'fail'
    )
  )::text,
  true
);

SELECT set_config(
  'test.migration_payload',
  jsonb_build_object(
    'account', jsonb_build_object(
      'display_name', 'Example Migrated Client',
      'client_code', 'example-migration-migrated-client',
      'service_tier', 'standard'
    ),
    'contacts', jsonb_build_array(
      jsonb_build_object('legacy_ref', 'FIXTURE-R-001', 'full_name', 'Example Recipient One', 'mobile', '+12025550101', 'mail', 'user-fe4d5e24@example.invalid', 'language', 'ar'),
      jsonb_build_object('legacy_ref', 'FIXTURE-R-002', 'full_name', 'Example Recipient Two', 'mobile', '+12025550102', 'mail', 'user-cd034e01@example.invalid', 'language', 'en')
    ),
    'credentials', jsonb_build_object('api_key', 'should-not-persist')
  )::text,
  true
);

SELECT set_config(
  'test.migration_validation',
  jsonb_set(
    current_setting('test.migration_validation')::jsonb,
    '{limits,max_payload_bytes}',
    to_jsonb(octet_length(current_setting('test.migration_payload')::jsonb::TEXT)),
    TRUE
  )::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_config_result',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-logistics-source',
    'display_name', 'Example Logistics Source',
    'provider_name', 'Example Source Provider',
    'profile_key', 'clients-and-recipients',
    'profile_display_name', 'Clients and recipients',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', current_setting('test.migration_validation')::jsonb,
    'redaction_profile', jsonb_build_object('fields', jsonb_build_array('api_key', 'password', 'token'))
  ))::text,
  true
);

SELECT set_config(
  'test.migration_preview_result',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', true,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::text,
  true
);

SELECT set_config(
  'test.migration_preview_client_count',
  (
    SELECT count(*)::text FROM public.clients
     WHERE organization_id = current_setting('test.migration_org')::UUID
       AND slug = 'example-migration-migrated-client'
  ),
  true
);

SELECT set_config(
  'test.migration_execute_result',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', false,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::text,
  true
);

SELECT set_config(
  'test.migration_duplicate_result',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', false,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::text,
  true
);

SELECT set_config(
  'test.migration_target_conflict',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-target-conflict',
    'dry_run', false,
    'payload', jsonb_build_object(
      'account', jsonb_build_object(
        'display_name', 'Example Conflict Client',
        'client_code', 'example-migration-conflict-client',
        'service_tier', 'standard'
      ),
      'contacts', jsonb_build_array(jsonb_build_object(
        'legacy_ref', 'FIXTURE-R-CONFLICT',
        'full_name', 'Example Conflict Recipient',
        'mobile', '+12025550103'
      ))
    )
  ))::text,
  true
);

SELECT set_config(
  'test.migration_payload_mismatch',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', false,
    'payload', jsonb_set(current_setting('test.migration_payload')::jsonb, '{account,display_name}', '"Changed Client"'::jsonb)
  ))::text,
  true
);

SELECT set_config(
  'test.migration_updated_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-logistics-source',
    'display_name', 'Example Logistics Source',
    'provider_name', 'Example Source Provider',
    'profile_key', 'clients-and-recipients',
    'profile_display_name', 'Clients and recipients',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', jsonb_set(
      current_setting('test.migration_validation')::jsonb,
      '{limits,max_recipients}',
      '3'::jsonb,
      TRUE
    )
  ))::text,
  true
);

SELECT set_config(
  'test.migration_config_mismatch',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_updated_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_updated_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', false,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::text,
  true
);

SELECT set_config(
  'test.migration_invalid_result',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_updated_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_updated_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-invalid',
    'dry_run', true,
    'payload', jsonb_build_object(
      'account', jsonb_build_object('display_name', 'Example Invalid Client', 'client_code', 'example-migration-invalid-client'),
      'contacts', jsonb_build_array(jsonb_build_object('legacy_ref', 'FIXTURE-BAD-001', 'full_name', 'Missing Phone'))
    )
  ))::text,
  true
);

SELECT set_config(
  'test.migration_second_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-second-source',
    'display_name', 'Example Second Source',
    'profile_key', 'second-profile',
    'profile_display_name', 'Second profile',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', jsonb_set(
      current_setting('test.migration_validation')::jsonb,
      '{limits,max_payload_bytes}',
      '262144'::jsonb,
      TRUE
    )
  ))::text,
  true
);

SELECT set_config(
  'test.migration_source_profile_mismatch',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_second_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-mismatched-source-profile',
    'dry_run', true,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::text,
  true
);

SELECT set_config(
  'test.migration_invalid_path_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-invalid-path-source',
    'display_name', 'Example Invalid Path Source',
    'profile_key', 'invalid-path-profile',
    'profile_display_name', 'Invalid path profile',
    'mapping_rules', jsonb_set(
      current_setting('test.migration_mapping')::jsonb,
      '{collections,recipients,source_path}',
      to_jsonb('$.contacts['::TEXT),
      TRUE
    ),
    'validation_rules', current_setting('test.migration_validation')::jsonb
  ))::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_invalid_limits_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-invalid-limits-source',
    'display_name', 'Example Invalid Limits Source',
    'profile_key', 'invalid-limits-profile',
    'profile_display_name', 'Invalid limits profile',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', jsonb_set(
      current_setting('test.migration_validation')::jsonb,
      '{limits,max_recipients}',
      '0'::jsonb,
      TRUE
    )
  ))::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_payload_limit_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-payload-limit-source',
    'display_name', 'Example Payload Limit Source',
    'profile_key', 'payload-limit-profile',
    'profile_display_name', 'Payload limit profile',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', jsonb_set(
      current_setting('test.migration_validation')::jsonb,
      '{limits,max_payload_bytes}',
      to_jsonb(octet_length(current_setting('test.migration_payload')::jsonb::TEXT) - 1),
      TRUE
    )
  ))::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_payload_over_limit',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_payload_limit_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_payload_limit_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-payload-over-limit',
    'dry_run', TRUE,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_recipient_over_limit',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_second_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_second_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-recipient-over-limit',
    'dry_run', TRUE,
    'payload', jsonb_set(
      jsonb_set(
        jsonb_set(
          current_setting('test.migration_payload')::jsonb,
          '{account,display_name}',
          '"Example Recipient Limit Client"'::jsonb
        ),
        '{account,client_code}',
        '"example-migration-recipient-limit-client"'::jsonb
      ),
      '{contacts}',
      (current_setting('test.migration_payload')::jsonb->'contacts')
        || jsonb_build_array(jsonb_build_object(
          'legacy_ref', 'FIXTURE-R-003',
          'full_name', 'Example Recipient Three',
          'mobile', '+12025550104'
        )),
      TRUE
    )
  ))::TEXT,
  TRUE
);

RESET ROLE;

SELECT set_config(
  'test.migration_original_workflow_binding',
  COALESCE((
    SELECT v.workflow_binding::TEXT
      FROM public.integration_plugin_versions v
     WHERE v.id = (
       current_setting('test.migration_config_result')::jsonb->>'plugin_version_id'
     )::UUID
  ), '{}'::TEXT),
  TRUE
);

UPDATE public.integration_plugin_versions
   SET workflow_binding = COALESCE(workflow_binding, '{}'::jsonb)
         || jsonb_build_object('readiness_drift', TRUE),
       updated_at = now()
 WHERE id = (
   current_setting('test.migration_config_result')::jsonb->>'plugin_version_id'
 )::UUID;

SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.migration_readiness_blocked_config',
  api.ui_upsert_logistics_customer_migration_config_v1(jsonb_build_object(
    'source_key', 'example-migration-readiness-blocked-source',
    'display_name', 'Example Readiness Blocked Source',
    'profile_key', 'readiness-blocked-profile',
    'profile_display_name', 'Readiness blocked profile',
    'mapping_rules', current_setting('test.migration_mapping')::jsonb,
    'validation_rules', current_setting('test.migration_validation')::jsonb
  ))::TEXT,
  TRUE
);

SELECT set_config(
  'test.migration_readiness_blocked_execute',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_second_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_second_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-readiness-drift',
    'dry_run', TRUE,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::TEXT,
  TRUE
);

RESET ROLE;

UPDATE public.integration_plugin_versions
   SET workflow_binding = current_setting('test.migration_original_workflow_binding')::jsonb,
       updated_at = now()
 WHERE id = (
   current_setting('test.migration_config_result')::jsonb->>'plugin_version_id'
 )::UUID;

UPDATE public.operation_handlers
   SET is_active = FALSE,
       updated_at = now()
 WHERE handler_key = 'logistics_customer_migration';

SET LOCAL ROLE authenticated;

SELECT set_config(
  'test.migration_engine_failure',
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_second_config')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_second_config')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-engine-failure',
    'dry_run', TRUE,
    'payload', current_setting('test.migration_payload')::jsonb
  ))::TEXT,
  TRUE
);

RESET ROLE;

UPDATE public.operation_handlers
   SET is_active = TRUE,
       updated_at = now()
 WHERE handler_key = 'logistics_customer_migration';

RESET ROLE;

SELECT is((current_setting('test.migration_config_result')::jsonb->>'ok')::BOOLEAN, TRUE, 'config RPC succeeds');
SELECT ok(
  NULLIF(current_setting('test.migration_config_result')::jsonb->>'plugin_binding_id', '') IS NOT NULL
  AND NULLIF(current_setting('test.migration_config_result')::jsonb->>'profile_config_sha256', '') IS NOT NULL,
  'config returns binding and profile digest evidence'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.logistics_migration_sources s
      JOIN public.integration_plugins p ON p.id = s.plugin_id
      JOIN public.integration_plugin_versions v ON v.id = p.active_version_id
      JOIN public.integration_plugin_bindings b ON b.id = s.plugin_binding_id
     WHERE s.id = (current_setting('test.migration_config_result')::jsonb->>'source_id')::UUID
       AND p.plugin_key = 'customer-logistics-migration'
       AND p.plugin_kind = 'api'
       AND p.status = 'active'
       AND v.status = 'active'
       AND COALESCE((v.validation_summary->>'ok')::BOOLEAN, FALSE)
       AND b.plugin_version_id = v.id
       AND b.enabled
  ),
  'config resolves an active validated version and canonical binding'
);

SELECT ok(
  NOT (current_setting('test.migration_invalid_path_config')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_invalid_path_config')::jsonb#>>'{error,code}' = 'mapping_source_path_invalid',
  'config save rejects invalid collection JSONPath'
);

SELECT ok(
  NOT (current_setting('test.migration_invalid_limits_config')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_invalid_limits_config')::jsonb#>>'{error,code}' = 'validation_limits_invalid',
  'config save rejects invalid stored execution limits'
);

SELECT diag('Customer migration preview failure: ' || jsonb_strip_nulls(jsonb_build_object(
  'code', result#>>'{error,code}',
  'sqlstate', result#>>'{error,sqlstate}',
  'message', COALESCE(result#>>'{error,message}', result#>>'{workflow_progress,error}')
))::TEXT)
FROM (SELECT current_setting('test.migration_preview_result')::jsonb AS result) preview
WHERE result->>'ok' IS DISTINCT FROM 'true';

SELECT is((current_setting('test.migration_preview_result')::jsonb->>'ok')::BOOLEAN, TRUE, 'preview succeeds');
SELECT is(current_setting('test.migration_preview_result')::jsonb->>'status', 'queued', 'valid preview leaves canonical import job queued');
SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.logistics_migration_requests r
      JOIN public.import_jobs j ON j.id = r.import_job_id
     WHERE r.import_job_id = (current_setting('test.migration_preview_result')::jsonb->>'import_job_id')::UUID
       AND j.status IN ('queued', 'completed')
  ),
  'preview and execute share a strict import job extension'
);

SELECT ok(
  current_setting('test.migration_preview_result')::jsonb#>>'{validation_summary,limits,max_recipients}' = '2'
  AND current_setting('test.migration_preview_result')::jsonb#>>'{validation_summary,limits,max_payload_bytes}' = octet_length(current_setting('test.migration_payload')::jsonb::TEXT)::TEXT
  AND current_setting('test.migration_preview_result')::jsonb#>>'{validation_summary,limits,payload_bytes}' = octet_length(current_setting('test.migration_payload')::jsonb::TEXT)::TEXT
  AND current_setting('test.migration_preview_result')::jsonb#>>'{validation_summary,recipients}' = '2'
  AND (current_setting('test.migration_execute_result')::jsonb->>'ok')::BOOLEAN,
  'exact recipient-count and payload-byte boundaries remain valid'
);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.workflow_runs wr
      JOIN public.workflow_run_steps wrs ON wrs.workflow_run_id = wr.id
     WHERE wr.id = (current_setting('test.migration_preview_result')::jsonb->>'workflow_run_id')::UUID
       AND wr.workflow_status = 'completed'
       AND wr.context->>'contract' = 'customer_logistics_migration_v1'
       AND wrs.handler_key = 'logistics_customer_migration'
       AND wrs.step_status = 'completed'
  ),
  'preview completes through the registered workflow handler'
);

SELECT is(current_setting('test.migration_preview_client_count')::INT, 0, 'preview does not materialize a client before execution');

SELECT ok(
  (current_setting('test.migration_execute_result')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_execute_result')::jsonb->>'status' = 'completed'
  AND current_setting('test.migration_execute_result')::jsonb->>'import_job_id' = current_setting('test.migration_preview_result')::jsonb->>'import_job_id',
  'execute completes the same canonical import job'
);

SELECT ok(NULLIF(current_setting('test.migration_execute_result')::jsonb->>'imported_client_id', '') IS NOT NULL, 'execute returns imported client id');
SELECT is(jsonb_array_length(current_setting('test.migration_execute_result')::jsonb->'imported_recipient_ids'), 2, 'execute returns both imported recipient ids');

SELECT is(
  (
    SELECT count(*)::INT FROM public.logistics_migration_items
     WHERE import_job_id = (current_setting('test.migration_execute_result')::jsonb->>'import_job_id')::UUID
       AND target_id IS NOT NULL
  ),
  3,
  'item lineage links one client and two recipients'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.clients c
     WHERE c.id = (current_setting('test.migration_execute_result')::jsonb->>'imported_client_id')::UUID
       AND c.name = 'Example Migrated Client'
       AND c.slug = 'example-migration-migrated-client'
  )
  AND EXISTS (
    SELECT 1 FROM public.recipients r
     WHERE r.client_id = (current_setting('test.migration_execute_result')::jsonb->>'imported_client_id')::UUID
       AND r.external_id = 'FIXTURE-R-001'
       AND r.name = 'Example Recipient One'
       AND r.phone_number = '+12025550101'
  ),
  'nonstandard source fields remain correlated through stored mapping rules'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.decision_log
     WHERE resource_type = 'client'
       AND resource_id = (current_setting('test.migration_execute_result')::jsonb->>'imported_client_id')::UUID
       AND decision_point = 'client_create_v1'
  )
  AND (
    SELECT count(*) >= 2 FROM public.domain_events
     WHERE resource_type = 'import_job'
       AND resource_id = (current_setting('test.migration_execute_result')::jsonb->>'import_job_id')::UUID
  ),
  'canonical product decision and import event lineage exists'
);

SELECT ok(
  (current_setting('test.migration_duplicate_result')::jsonb->>'idempotency_reused')::BOOLEAN
  AND current_setting('test.migration_duplicate_result')::jsonb->>'import_job_id' = current_setting('test.migration_execute_result')::jsonb->>'import_job_id',
  'exact duplicate execution reuses the canonical job'
);

SELECT diag('Customer migration target conflict result: ' || jsonb_build_object(
  'ok', result->'ok',
  'code', result#>>'{error,code}',
  'message', COALESCE(result#>>'{error,message}', result#>>'{workflow_progress,error}')
)::TEXT)
FROM (SELECT current_setting('test.migration_target_conflict')::jsonb AS result) conflict;

SELECT ok(
  NOT (current_setting('test.migration_target_conflict')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_target_conflict')::jsonb#>>'{error,code}' = 'validation_failed',
  'stored fail-closed conflict policy rejects an existing recipient phone'
);

SELECT ok(
  NOT (current_setting('test.migration_payload_mismatch')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_payload_mismatch')::jsonb#>>'{error,code}' = 'idempotency_identity_mismatch',
  'changed payload for the same external batch fails closed'
);

SELECT is(
  (
    SELECT count(*)::INT FROM public.logistics_migration_requests
     WHERE organization_id = current_setting('test.migration_org')::UUID
       AND external_batch_id = 'example-migration-batch-001'
  ),
  1,
  'one external batch has exactly one canonical import extension'
);

SELECT ok(
  current_setting('test.migration_updated_config')::jsonb->>'source_id' = current_setting('test.migration_config_result')::jsonb->>'source_id'
  AND current_setting('test.migration_updated_config')::jsonb->>'profile_id' = current_setting('test.migration_config_result')::jsonb->>'profile_id'
  AND current_setting('test.migration_updated_config')::jsonb->>'profile_config_sha256' <> current_setting('test.migration_config_result')::jsonb->>'profile_config_sha256',
  'stored limit update preserves row identity and changes the profile digest'
);

SELECT ok(
  NOT (current_setting('test.migration_config_mismatch')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_config_mismatch')::jsonb#>>'{error,code}' = 'idempotency_identity_mismatch',
  'changed stored limit digest for the same batch fails closed'
);

SELECT ok(
  NOT (current_setting('test.migration_invalid_result')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_invalid_result')::jsonb->>'status' = 'failed'
  AND EXISTS (
    SELECT 1 FROM public.import_jobs
     WHERE id = (current_setting('test.migration_invalid_result')::jsonb->>'import_job_id')::UUID
       AND status = 'failed'
  )
  AND EXISTS (
    SELECT 1 FROM public.workflow_runs
     WHERE id = (current_setting('test.migration_invalid_result')::jsonb->>'workflow_run_id')::UUID
       AND workflow_status = 'failed'
  ),
  'stored required-field rules fail the import job and workflow together'
);

SELECT ok(
  NOT (current_setting('test.migration_payload_over_limit')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_payload_over_limit')::jsonb#>>'{error,code}' = 'validation_failed'
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(
        current_setting('test.migration_payload_over_limit')::jsonb#>'{validation_summary,errors}',
        '[]'::jsonb
      )) AS error(value)
     WHERE error.value->>'code' = 'max_payload_bytes'
  ),
  'payload exceeding the stored byte ceiling fails before mapping or product writes'
);

SELECT ok(
  NOT (current_setting('test.migration_recipient_over_limit')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_recipient_over_limit')::jsonb#>>'{error,code}' = 'validation_failed'
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(
        current_setting('test.migration_recipient_over_limit')::jsonb#>'{validation_summary,errors}',
        '[]'::jsonb
      )) AS error(value)
     WHERE error.value->>'code' = 'max_items'
  ),
  'recipient collection exceeding the stored maximum fails before product writes'
);

SELECT ok(
  NOT (current_setting('test.migration_source_profile_mismatch')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_source_profile_mismatch')::jsonb#>>'{error,code}' = 'profile_not_found_or_inactive',
  'source and profile mismatch is rejected'
);

SELECT ok(
  NOT (current_setting('test.migration_readiness_blocked_config')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_readiness_blocked_config')::jsonb#>>'{error,code}'
    = 'canonical_onboarding_readiness_blocked'
  AND EXISTS (
    SELECT 1
      FROM jsonb_array_elements(COALESCE(
        current_setting('test.migration_readiness_blocked_config')::jsonb
          #>'{onboarding_readiness,items}',
        '[]'::jsonb
      )) AS readiness_item(value)
     WHERE readiness_item.value->>'plugin_key' = 'customer-logistics-migration'
       AND readiness_item.value->>'status' = 'blocked'
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.logistics_migration_sources
     WHERE organization_id = current_setting('test.migration_org')::UUID
       AND source_key = 'example-migration-readiness-blocked-source'
  ),
  'config save enforces canonical plugin readiness before writing source rows'
);

SELECT ok(
  NOT (current_setting('test.migration_readiness_blocked_execute')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_readiness_blocked_execute')::jsonb#>>'{error,code}'
    = 'canonical_onboarding_readiness_blocked'
  AND NOT EXISTS (
    SELECT 1
      FROM public.logistics_migration_requests
     WHERE organization_id = current_setting('test.migration_org')::UUID
       AND external_batch_id = 'example-migration-readiness-drift'
  ),
  'execution rejects canonical readiness drift before creating an import lifecycle'
);

SELECT ok(
  NOT (current_setting('test.migration_engine_failure')::jsonb->>'ok')::BOOLEAN
  AND current_setting('test.migration_engine_failure')::jsonb->>'status' = 'failed'
  AND current_setting('test.migration_engine_failure')::jsonb#>>'{error,code}'
    = 'workflow_progress_failed'
  AND EXISTS (
    SELECT 1
      FROM public.import_jobs j
     WHERE j.id = (
       current_setting('test.migration_engine_failure')::jsonb->>'import_job_id'
     )::UUID
       AND j.status = 'failed'
       AND j.error_summary->>'code' = 'workflow_progress_failed'
  )
  AND EXISTS (
    SELECT 1
      FROM public.workflow_runs wr
     WHERE wr.id = (
       current_setting('test.migration_engine_failure')::jsonb->>'workflow_run_id'
     )::UUID
       AND wr.workflow_status = 'failed'
  )
  AND EXISTS (
    SELECT 1
      FROM public.decision_log d
     WHERE d.id = (
       current_setting('test.migration_engine_failure')::jsonb->>'decision_log_id'
     )::UUID
       AND d.decision_outcome = 'failed'
  )
  AND EXISTS (
    SELECT 1
      FROM public.domain_events de
     WHERE de.resource_type = 'import_job'
       AND de.resource_id = (
         current_setting('test.migration_engine_failure')::jsonb->>'import_job_id'
       )::UUID
       AND de.event_type = 'import_job.failed'
       AND de.workflow_run_id = (
         current_setting('test.migration_engine_failure')::jsonb->>'workflow_run_id'
       )::UUID
  ),
  'workflow engine failure returns a persisted failed import with workflow, decision, and event lineage'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.logistics_migration_requests r
      LEFT JOIN public.logistics_migration_items i ON i.import_job_id = r.import_job_id
      LEFT JOIN public.decision_log d ON d.resource_id = r.import_job_id
      LEFT JOIN public.workflow_run_steps wrs
        ON wrs.workflow_run_id IN (r.preview_workflow_run_id, r.execution_workflow_run_id)
     WHERE r.organization_id = current_setting('test.migration_org')::UUID
       AND (
         r.redaction_summary::text ILIKE '%should-not-persist%'
         OR i.result_summary::text ILIKE '%should-not-persist%'
         OR d.decision_inputs::text ILIKE '%should-not-persist%'
         OR wrs.operation_result::text ILIKE '%should-not-persist%'
       )
  ),
  'raw secret values never enter migration, decision, or workflow readback'
);

SELECT ok(
  public.onboarding_integration_plugin_readiness_v1('tenant', current_setting('test.migration_org')::UUID)::text
    ILIKE '%customer-logistics-migration%',
  'canonical onboarding readiness includes the required migration plugin'
);

SELECT ok(
  EXISTS (
    SELECT 1 FROM public.audit_table_changes
     WHERE table_name IN ('logistics_migration_sources', 'logistics_migration_profiles', 'logistics_migration_requests', 'logistics_migration_items')
       AND op IN ('INSERT', 'UPDATE')
       AND organization_id = current_setting('test.migration_org')::UUID
  ),
  'migration source, profile, extension, and item changes are audited'
);

SET LOCAL ROLE authenticated;

SELECT ok(
  EXISTS (SELECT 1 FROM public.logistics_migration_sources
    WHERE id = (current_setting('test.migration_config_result')::jsonb->>'source_id')::UUID)
  AND EXISTS (SELECT 1 FROM public.logistics_migration_profiles
    WHERE id = (current_setting('test.migration_config_result')::jsonb->>'profile_id')::UUID)
  AND EXISTS (SELECT 1 FROM public.logistics_migration_requests
    WHERE import_job_id = (current_setting('test.migration_execute_result')::jsonb->>'import_job_id')::UUID),
  'the authenticated owning operator can read its source, profile, and batch'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.migration_other_actor'), true);
SELECT set_config(
  'request.jwt.claims',
  jsonb_build_object('sub', current_setting('test.migration_other_actor'), 'role', 'authenticated')::text,
  true
);

SELECT is(
  (SELECT count(*) FROM public.logistics_migration_sources
    WHERE organization_id = current_setting('test.migration_org')::UUID),
  0::BIGINT,
  'a second organization cannot read migration sources'
);
SELECT is(
  (SELECT count(*) FROM public.logistics_migration_profiles
    WHERE organization_id = current_setting('test.migration_org')::UUID),
  0::BIGINT,
  'a second organization cannot read migration profiles'
);
SELECT is(
  (SELECT count(*) FROM public.logistics_migration_requests
    WHERE organization_id = current_setting('test.migration_org')::UUID),
  0::BIGINT,
  'a second organization cannot read migration batches'
);
SELECT is(
  api.ui_execute_logistics_customer_migration_v1(jsonb_build_object(
    'source_id', current_setting('test.migration_config_result')::jsonb->>'source_id',
    'profile_id', current_setting('test.migration_config_result')::jsonb->>'profile_id',
    'external_batch_id', 'example-migration-batch-001',
    'dry_run', TRUE,
    'payload', current_setting('test.migration_payload')::jsonb
  ))#>>'{error,code}',
  'source_not_found_or_inactive',
  'a second organization cannot preview an existing batch from the owning organization'
);

RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
