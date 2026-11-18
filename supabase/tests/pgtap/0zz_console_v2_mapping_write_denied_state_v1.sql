-- pgTAP: Console V2 Mapping Studio write/report actions deny lower-permission
-- users before mutating mapping state or persisting report/lineage side effects.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(19);

SET search_path TO public, pgtap, extensions, pg_temp;

DO $$
DECLARE
  v_org UUID := '00000000-0000-0000-0000-00000000d761';
  v_ops UUID := '00000000-0000-0000-0000-00000000d762';
  v_limited UUID := '00000000-0000-0000-0000-00000000d763';
  v_mapping UUID := '00000000-0000-0000-0000-00000000d764';
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO public.organizations (id, name, slug)
  VALUES (v_org, 'Console V2 Mapping Write Denied Org', 'console-v2-mapping-write-denied')
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES
    (v_ops, v_org, 'mapping-write-denied-ops@example.com', 'Mapping Write Denied Ops', 'ops_admin', 'tenant', NULL),
    (v_limited, v_org, 'mapping-write-denied-limited@example.com', 'Mapping Write Denied Limited', 'driver', 'tenant', NULL)
  ON CONFLICT (id) DO NOTHING;

  INSERT INTO public.mapping_configs (
    id,
    organization_id,
    mapping_type,
    mapping_key,
    mapping_config,
    mapping_version,
    notes
  )
  VALUES (
    v_mapping,
    v_org,
    'webhook_inbound',
    'console-v2-mapping-write-denied',
    jsonb_build_object('target', 'shipments.create', 'enabled', TRUE),
    1,
    'Console V2 mapping write denied-state pgTAP mapping'
  )
  ON CONFLICT (id) DO UPDATE
     SET organization_id = EXCLUDED.organization_id,
         mapping_type = EXCLUDED.mapping_type,
         mapping_key = EXCLUDED.mapping_key,
         mapping_config = EXCLUDED.mapping_config,
         mapping_version = EXCLUDED.mapping_version,
         notes = EXCLUDED.notes;

  DELETE FROM public.mapping_config_revisions WHERE mapping_config_id = v_mapping;
  DELETE FROM public.mapping_operation_reports
   WHERE primary_resource_type = 'mapping_config'
     AND primary_resource_id = v_mapping;
  DELETE FROM public.decision_log
   WHERE organization_id = v_org
     AND resource_type = 'mapping_config'
     AND resource_id = v_mapping;
  DELETE FROM public.domain_events
   WHERE organization_id = v_org
     AND resource_type = 'mapping_config'
     AND resource_id = v_mapping;

  PERFORM set_config('test.mapping_write_denied_org', v_org::TEXT, TRUE);
  PERFORM set_config('test.mapping_write_denied_ops', v_ops::TEXT, TRUE);
  PERFORM set_config('test.mapping_write_denied_limited', v_limited::TEXT, TRUE);
  PERFORM set_config('test.mapping_write_denied_mapping', v_mapping::TEXT, TRUE);

  EXECUTE 'RESET ROLE';
END $$;

SELECT ok(
  to_regprocedure('api.ui_upsert_mapping_artifact_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_upsert_mapping_artifact_v1(jsonb)', 'EXECUTE'),
  'api.ui_upsert_mapping_artifact_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.mapping_config_promote_v1(jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.mapping_config_promote_v1(jsonb)', 'EXECUTE'),
  'api.mapping_config_promote_v1 wrapper is available to authenticated users'
);

SELECT ok(
  to_regprocedure('api.ui_test_mapping_config_v1(uuid,jsonb)') IS NOT NULL
  AND has_function_privilege('authenticated', 'api.ui_test_mapping_config_v1(uuid,jsonb)', 'EXECUTE'),
  'api.ui_test_mapping_config_v1 wrapper is available to authenticated users'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_upsert_mapping_config_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.mapping_write_denied_mapping'),
       'mapping_type', 'webhook_inbound',
       'mapping_key', 'console-v2-mapping-write-denied',
       'mapping_config', jsonb_build_object('target', 'shipments.create', 'enabled', FALSE)
     )) $$,
  '42501',
  NULL,
  'limited user denied public ui_upsert_mapping_config_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_upsert_mapping_artifact_v1(jsonb_build_object(
       'artifact', 'mapping_config',
       'organization_id', current_setting('test.mapping_write_denied_org'),
       'mapping_config_id', current_setting('test.mapping_write_denied_mapping'),
       'mapping_type', 'webhook_inbound',
       'mapping_key', 'console-v2-mapping-write-denied',
       'mapping_config', jsonb_build_object('target', 'shipments.create', 'enabled', FALSE)
     )) $$,
  '42501',
  NULL,
  'limited user denied api ui_upsert_mapping_artifact_v1 mapping_config update'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND mapping_version = 1
       AND COALESCE((mapping_config->>'enabled')::BOOLEAN, TRUE) IS TRUE
       AND mapping_config->>'target' = 'shipments.create'
  ),
  'denied mapping upsert attempts leave mapping_config state unchanged'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.mapping_config_promote_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.mapping_write_denied_mapping')
     )) $$,
  '42501',
  NULL,
  'limited user denied public mapping_config_promote_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.mapping_config_promote_v1(jsonb_build_object(
       'mapping_config_id', current_setting('test.mapping_write_denied_mapping')
     )) $$,
  '42501',
  NULL,
  'limited user denied api mapping_config_promote_v1'
);
RESET ROLE;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.mapping_config_revisions
     WHERE mapping_config_id = current_setting('test.mapping_write_denied_mapping')::UUID
  ),
  'denied promote attempts write no mapping_config_revisions rows'
);

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE organization_id = current_setting('test.mapping_write_denied_org')::UUID
       AND resource_type = 'mapping_config'
       AND resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
  )
  AND NOT EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE organization_id = current_setting('test.mapping_write_denied_org')::UUID
       AND resource_type = 'mapping_config'
       AND resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
  ),
  'denied promote attempts write no decision-log or domain-event lineage'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT public.ui_test_mapping_config_v1(
       current_setting('test.mapping_write_denied_mapping')::UUID,
       jsonb_build_object('shipment', jsonb_build_object('external_id', 'DENIED-MAP-TEST-PUBLIC'))
     ) $$,
  '42501',
  NULL,
  'limited user denied public ui_test_mapping_config_v1'
);
RESET ROLE;

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_limited'), TRUE);
SET LOCAL ROLE authenticated;
SELECT throws_ok(
  $$ SELECT api.ui_test_mapping_config_v1(
       current_setting('test.mapping_write_denied_mapping')::UUID,
       jsonb_build_object('shipment', jsonb_build_object('external_id', 'DENIED-MAP-TEST-API'))
     ) $$,
  '42501',
  NULL,
  'limited user denied api ui_test_mapping_config_v1'
);
RESET ROLE;

SELECT ok(
  NOT EXISTS (
    SELECT 1
      FROM public.mapping_operation_reports
     WHERE primary_resource_type = 'mapping_config'
       AND primary_resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
  ),
  'denied mapping test attempts write no mapping_operation_reports rows'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (api.ui_upsert_mapping_artifact_v1(jsonb_build_object(
    'artifact', 'mapping_config',
    'organization_id', current_setting('test.mapping_write_denied_org'),
    'mapping_config_id', current_setting('test.mapping_write_denied_mapping'),
    'mapping_type', 'webhook_inbound',
    'mapping_key', 'console-v2-mapping-write-denied',
    'mapping_config', jsonb_build_object('target', 'shipments.create', 'enabled', FALSE)
  ))->>'ok')::BOOLEAN,
  'ops user can update mapping_config through api.ui_upsert_mapping_artifact_v1'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND mapping_version = 2
       AND COALESCE((mapping_config->>'enabled')::BOOLEAN, TRUE) IS FALSE
  ),
  'allowed mapping upsert disables mapping and increments version'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (api.ui_test_mapping_config_v1(
    current_setting('test.mapping_write_denied_mapping')::UUID,
    jsonb_build_object('shipment', jsonb_build_object('external_id', 'ALLOWED-MAP-TEST'))
  )->>'ok')::BOOLEAN,
  'ops user can run mapping test through api.ui_test_mapping_config_v1'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_operation_reports
     WHERE primary_resource_type = 'mapping_config'
       AND primary_resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND operation_kind = 'mapping_test'
       AND status = 'succeeded'
  ),
  'allowed mapping test persists mapping_operation_reports evidence'
);

SELECT set_config('request.jwt.claim.sub', current_setting('test.mapping_write_denied_ops'), TRUE);
SET LOCAL ROLE authenticated;
SELECT ok(
  (api.mapping_config_promote_v1(jsonb_build_object(
    'mapping_config_id', current_setting('test.mapping_write_denied_mapping')
  ))->>'ok')::BOOLEAN,
  'ops user can promote mapping through api.mapping_config_promote_v1'
);
RESET ROLE;

SELECT ok(
  EXISTS (
    SELECT 1
      FROM public.mapping_configs
     WHERE id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND mapping_version = 3
  )
  AND EXISTS (
    SELECT 1
      FROM public.mapping_config_revisions
     WHERE mapping_config_id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND promoted_from_version = 2
       AND promoted_to_version = 3
  )
  AND EXISTS (
    SELECT 1
      FROM public.decision_log
     WHERE organization_id = current_setting('test.mapping_write_denied_org')::UUID
       AND resource_type = 'mapping_config'
       AND resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND decision_point = 'mapping_config_promote_v1'
  )
  AND EXISTS (
    SELECT 1
      FROM public.domain_events
     WHERE organization_id = current_setting('test.mapping_write_denied_org')::UUID
       AND resource_type = 'mapping_config'
       AND resource_id = current_setting('test.mapping_write_denied_mapping')::UUID
       AND event_type = 'mapping_config.promoted'
  ),
  'allowed promote increments mapping version and appends revision, decision, and domain lineage'
);

SELECT * FROM finish();

ROLLBACK;
