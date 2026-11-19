-- Test Suite: Console V2 safe settings auto-apply RPC
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(6);

SELECT has_function(
  'api',
  'ui_apply_settings_value_v1',
  ARRAY['text', 'text', 'uuid', 'jsonb', 'text'],
  'api.ui_apply_settings_value_v1 wrapper exists'
);

SELECT ok(
  has_function_privilege(
    'authenticated',
    'api.ui_apply_settings_value_v1(text,text,uuid,jsonb,text)',
    'EXECUTE'
  ),
  'authenticated can execute api.ui_apply_settings_value_v1'
);

DO $$
DECLARE
  v_org UUID := gen_random_uuid();
  v_user UUID := gen_random_uuid();
  v_result JSONB;
  v_settings_version UUID;
  v_policy JSONB := jsonb_build_object(
    'version', 1,
    'enabled', true,
    'default_bank_account_key', null,
    'bank_statement_event_type', 'bank_statement',
    'match', jsonb_build_object(
      'window_days_before', 2,
      'window_days_after', 2,
      'amount_tolerance', 0,
      'require_unique', true
    )
  );
BEGIN
  EXECUTE 'SET LOCAL ROLE postgres';

  INSERT INTO organizations (id, name, slug)
  VALUES (v_org, 'Settings Apply Org', 'settings-apply-org-' || left(v_org::text, 8));

  INSERT INTO users (id, organization_id, email, full_name, user_type, access_scope_type, access_scope_id)
  VALUES (
    v_user,
    v_org,
    'settings-apply-' || left(v_user::text, 8) || '@example.com',
    'Settings Apply User',
    'ops_admin',
    'tenant',
    NULL
  );

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('role', 'authenticated')::text, true);
  EXECUTE 'SET LOCAL ROLE authenticated';

  SELECT api.ui_apply_settings_value_v1(
    'bank_reconciliation_policy',
    'tenant',
    v_org,
    v_policy,
    'pgTAP safe apply'
  )
    INTO v_result;

  v_settings_version := (v_result->>'settings_version_id')::uuid;

  PERFORM ok((v_result->>'applied')::boolean, 'safe policy apply returns applied=true');
  PERFORM ok(v_settings_version IS NOT NULL, 'safe policy apply returns settings_version_id');

  EXECUTE 'RESET ROLE';
  EXECUTE 'SET LOCAL ROLE postgres';

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.settings_versions sv
       WHERE sv.id = v_settings_version
         AND sv.category = 'bank_reconciliation_policy'
         AND sv.scope_type = 'tenant'
         AND sv.scope_id = v_org
         AND sv.approved_at IS NOT NULL
         AND sv.value->>'enabled' = 'true'
    ),
    'settings_versions active apply row is approved and stores enabled policy'
  );

  PERFORM ok(
    EXISTS (
      SELECT 1
        FROM public.domain_events de
       WHERE de.resource_type = 'settings_version'
         AND de.resource_id = v_settings_version
         AND de.event_type = 'settings_change.applied'
    ),
    'safe settings apply emits settings_change.applied domain event'
  );
END $$;

SELECT * FROM finish();
ROLLBACK;
