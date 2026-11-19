-- Migration: Console V2 live contract closure
-- Purpose:
--   - Add missing canonical write RPCs for feature-flag create/update and
--     provider credential upsert.
--   - Expose browser-safe api-schema wrappers for Console V2 lifecycle RPCs
--     that the browser client invokes through db.schema='api'.
BEGIN;

SELECT pg_advisory_lock(hashtext('202605041345_console_v2_live_contract_closure_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.create_feature_flag_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_key TEXT := NULLIF(btrim(COALESCE(p_args->>'flag_key', p_args->>'name', '')), '');
  v_description TEXT := NULLIF(btrim(COALESCE(p_args->>'description', '')), '');
  v_status TEXT := COALESCE(NULLIF(btrim(COALESCE(p_args->>'initial_status', p_args->>'status', '')), ''), 'off');
  v_scope_type TEXT := COALESCE(NULLIF(btrim(p_args->>'scope_type'), ''), 'global');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_enabled BOOLEAN := FALSE;
  v_rollout INTEGER := 0;
  v_conditions JSONB := '{}'::jsonb;
  v_flag_id UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('feature_flags.write');

  IF v_key IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires flag_key or name'
      USING ERRCODE = '23502';
  END IF;

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  ELSIF v_scope_id IS NULL THEN
    RAISE EXCEPTION 'create_feature_flag_v1 requires scope_id for scope_type=%', v_scope_type
      USING ERRCODE = '23502';
  END IF;

  IF v_status = 'on' THEN
    v_enabled := TRUE;
    v_rollout := 100;
  ELSIF v_status = 'percentage' THEN
    v_enabled := TRUE;
    v_rollout := LEAST(100, GREATEST(0, COALESCE(NULLIF(p_args->>'rollout_percentage', '')::int, 1)));
  ELSE
    v_enabled := FALSE;
    v_rollout := 0;
  END IF;

  v_conditions := jsonb_strip_nulls(jsonb_build_object(
    'label', NULLIF(btrim(COALESCE(p_args->>'flag_label', p_args->>'label', '')), ''),
    'owners', COALESCE(p_args->'owners', '[]'::jsonb),
    'scopes', COALESCE(p_args#>'{targeting,scopes}', '[]'::jsonb),
    'last_updated_by_user_id', v_user_id
  ));

  INSERT INTO public.feature_flags (
    name,
    description,
    scope_type,
    scope_id,
    enabled,
    rollout_percentage,
    conditions
  ) VALUES (
    v_key,
    v_description,
    v_scope_type,
    v_scope_id,
    v_enabled,
    v_rollout,
    v_conditions
  )
  RETURNING id INTO v_flag_id;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag_id,
    'name', v_key,
    'enabled', v_enabled,
    'rollout_percentage', v_rollout,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.create_feature_flag_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.create_feature_flag_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.create_feature_flag_v1(jsonb)
  IS 'Canonical write RPC: create a feature_flags row. Capability: feature_flags.write.';

CREATE OR REPLACE FUNCTION public.update_feature_flag_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_flag_id UUID := NULLIF(p_args->>'feature_flag_id', '')::uuid;
  v_flag_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', p_args->>'flag_key', '')), '');
  v_flag public.feature_flags%ROWTYPE;
  v_conditions JSONB;
  v_scope_type TEXT := NULLIF(btrim(p_args->>'scope_type'), '');
  v_scope_id UUID := NULLIF(p_args->>'scope_id', '')::uuid;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('feature_flags.write');

  IF v_flag_id IS NULL AND v_flag_name IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 requires feature_flag_id or name'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_flag
    FROM public.feature_flags
   WHERE (v_flag_id IS NULL OR id = v_flag_id)
     AND (v_flag_name IS NULL OR name = v_flag_name)
   ORDER BY updated_at DESC
   LIMIT 1
   FOR UPDATE;

  IF v_flag.id IS NULL THEN
    RAISE EXCEPTION 'update_feature_flag_v1 feature_flag % not found',
      COALESCE(v_flag_id::text, v_flag_name)
      USING ERRCODE = '23503';
  END IF;

  v_conditions := COALESCE(v_flag.conditions, '{}'::jsonb);

  IF p_args ? 'conditions' THEN
    v_conditions := v_conditions || COALESCE(p_args->'conditions', '{}'::jsonb);
  END IF;
  IF p_args ? 'targeting' THEN
    v_conditions := jsonb_set(
      v_conditions,
      '{scopes}',
      COALESCE(p_args#>'{targeting,scopes}', '[]'::jsonb),
      TRUE
    );
  END IF;
  IF p_args ? 'owners' THEN
    v_conditions := jsonb_set(v_conditions, '{owners}', COALESCE(p_args->'owners', '[]'::jsonb), TRUE);
  END IF;

  v_conditions := jsonb_set(v_conditions, '{last_updated_by_user_id}', to_jsonb(v_user_id::text), TRUE);

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  END IF;

  UPDATE public.feature_flags
     SET description = CASE WHEN p_args ? 'description' THEN NULLIF(btrim(p_args->>'description'), '') ELSE description END,
         scope_type = COALESCE(v_scope_type, scope_type),
         scope_id = CASE WHEN v_scope_type IS NULL THEN scope_id ELSE v_scope_id END,
         conditions = v_conditions,
         updated_at = now()
   WHERE id = v_flag.id;

  RETURN jsonb_build_object(
    'ok', true,
    'feature_flag_id', v_flag.id,
    'name', v_flag.name,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.update_feature_flag_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.update_feature_flag_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.update_feature_flag_v1(jsonb)
  IS 'Canonical write RPC: update feature_flags profile/targeting metadata. Capability: feature_flags.write.';

CREATE OR REPLACE FUNCTION public.ui_upsert_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_user_org_id UUID := public.current_user_org_id();
  v_config_id UUID := COALESCE(
    NULLIF(p_args->>'config_id', '')::uuid,
    NULLIF(p_args->>'provider_auth_config_id', '')::uuid
  );
  v_provider_id UUID := NULLIF(p_args->>'provider_id', '')::uuid;
  v_auth_type TEXT := NULLIF(btrim(p_args->>'auth_type'), '');
  v_credentials JSONB := CASE WHEN p_args ? 'credentials' THEN p_args->'credentials' ELSE NULL END;
  v_credentials_vault_id UUID := NULLIF(p_args->>'credentials_vault_id', '')::uuid;
  v_expires_at TIMESTAMPTZ := NULLIF(p_args->>'expires_at', '')::timestamptz;
  v_existing_provider_id UUID;
  v_target_org UUID;
  v_correlation_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_config_id IS NULL THEN
    IF v_provider_id IS NULL OR v_auth_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires provider_id and auth_type for create'
        USING ERRCODE = '23502';
    END IF;
    IF v_credentials IS NULL AND v_credentials_vault_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 requires credentials or credentials_vault_id for create'
        USING ERRCODE = '23502';
    END IF;
  END IF;

  IF v_config_id IS NOT NULL THEN
    SELECT pac.provider_id, p.organization_id
      INTO v_existing_provider_id, v_target_org
      FROM public.provider_auth_configs pac
      JOIN public.providers p ON p.id = pac.provider_id
     WHERE pac.id = v_config_id
     LIMIT 1;

    IF v_existing_provider_id IS NULL OR v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;

    IF v_provider_id IS NULL THEN
      v_provider_id := v_existing_provider_id;
    ELSIF v_provider_id <> v_existing_provider_id THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 config % belongs to provider %, not %',
        v_config_id, v_existing_provider_id, v_provider_id
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_config_id IS NULL THEN
    SELECT organization_id INTO v_target_org
      FROM public.providers
     WHERE id = v_provider_id;
  END IF;

  IF v_provider_id IS NULL OR v_target_org IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % not found', v_provider_id
      USING ERRCODE = '23503';
  END IF;

  IF v_user_org_id IS NOT NULL
     AND v_target_org <> v_user_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider % outside tenant scope', v_provider_id
      USING ERRCODE = '42501';
  END IF;

  IF v_config_id IS NULL THEN
    INSERT INTO public.provider_auth_configs (
      provider_id,
      auth_type,
      credentials,
      credentials_vault_id,
      expires_at
    ) VALUES (
      v_provider_id,
      v_auth_type,
      v_credentials,
      v_credentials_vault_id,
      v_expires_at
    )
    RETURNING id INTO v_config_id;
  ELSE
    UPDATE public.provider_auth_configs
       SET auth_type = COALESCE(v_auth_type, auth_type),
           credentials = COALESCE(v_credentials, credentials),
           credentials_vault_id = COALESCE(v_credentials_vault_id, credentials_vault_id),
           expires_at = CASE WHEN p_args ? 'expires_at' THEN v_expires_at ELSE expires_at END
     WHERE id = v_config_id
       AND provider_id = v_provider_id;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'ui_upsert_provider_auth_config_v1 provider_auth_config % not found', v_config_id
        USING ERRCODE = '23503';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_auth_config_id', v_config_id,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_correlation_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_provider_auth_config_v1(jsonb)
  IS 'Canonical write RPC: create/update provider_auth_configs credential pointers. Capability: integration_plugins.write.';

CREATE OR REPLACE VIEW public.v_feature_flag_summary
  WITH (security_invoker = true)
AS
SELECT
  ff.id,
  ff.name AS key,
  COALESCE(NULLIF(btrim(ff.conditions->>'label'), ''), initcap(replace(ff.name, '_', ' '))) AS label,
  ff.description,
  CASE
    WHEN NOT ff.enabled THEN 'off'
    WHEN ff.enabled AND ff.rollout_percentage >= 100 THEN 'on'
    ELSE 'percentage'
  END AS status,
  ff.rollout_percentage,
  jsonb_build_object(
    'summary',
    CASE
      WHEN ff.conditions ? 'scopes'
        AND jsonb_typeof(ff.conditions->'scopes') = 'array'
      THEN (jsonb_array_length(ff.conditions->'scopes'))::text || ' scopes'
      ELSE 'no overrides'
    END,
    'scopes',
    COALESCE(ff.conditions->'scopes', '[]'::jsonb)
  ) AS targeting,
  ff.scope_type,
  ff.scope_id,
  (NOT ff.enabled) AS kill_switch,
  COALESCE(ff.conditions->'owners', '[]'::jsonb) AS owners,
  ff.updated_at AS last_updated_at,
  (ff.conditions->>'last_updated_by_user_id') AS last_updated_by_user_id,
  ff.created_at,
  ff.updated_at
FROM public.feature_flags ff;

COMMENT ON VIEW public.v_feature_flag_summary IS
  'FE-friendly projection of feature_flags. Label prefers conditions.label written by create_feature_flag_v1, then humanized feature_flags.name.';

REVOKE ALL ON public.v_feature_flag_summary FROM PUBLIC;
REVOKE ALL ON public.v_feature_flag_summary FROM anon;
REVOKE ALL ON public.v_feature_flag_summary FROM authenticated;
GRANT SELECT ON public.v_feature_flag_summary TO service_role;

CREATE SCHEMA IF NOT EXISTS api;
REVOKE ALL ON SCHEMA api FROM PUBLIC;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

DO $$
DECLARE
  v_wrapper RECORD;
  f RECORD;
  v_args TEXT;
  v_identity_args TEXT;
  v_result TEXT;
  v_call_args TEXT;
  v_sql TEXT;
  v_is_set BOOLEAN;
  i INTEGER;
BEGIN
  -- Keep wrapper targets explicit while retaining their catalog signatures.
  FOR v_wrapper IN
    SELECT * FROM (VALUES
    ('create_support_case_v1',
     'CREATE OR REPLACE FUNCTION api.create_support_case_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.create_support_case_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.create_support_case_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.create_support_case_v1(%s) IS %L'),
    ('update_support_case_v1',
     'CREATE OR REPLACE FUNCTION api.update_support_case_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.update_support_case_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.update_support_case_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.update_support_case_v1(%s) IS %L'),
    ('assign_support_case_v1',
     'CREATE OR REPLACE FUNCTION api.assign_support_case_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.assign_support_case_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.assign_support_case_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.assign_support_case_v1(%s) IS %L'),
    ('bulk_assign_support_cases_v1',
     'CREATE OR REPLACE FUNCTION api.bulk_assign_support_cases_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.bulk_assign_support_cases_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.bulk_assign_support_cases_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.bulk_assign_support_cases_v1(%s) IS %L'),
    ('resolve_support_case_v1',
     'CREATE OR REPLACE FUNCTION api.resolve_support_case_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.resolve_support_case_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.resolve_support_case_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.resolve_support_case_v1(%s) IS %L'),
    ('bulk_resolve_support_cases_v1',
     'CREATE OR REPLACE FUNCTION api.bulk_resolve_support_cases_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.bulk_resolve_support_cases_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.bulk_resolve_support_cases_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.bulk_resolve_support_cases_v1(%s) IS %L'),
    ('reopen_support_case_v1',
     'CREATE OR REPLACE FUNCTION api.reopen_support_case_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.reopen_support_case_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.reopen_support_case_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.reopen_support_case_v1(%s) IS %L'),
    ('send_support_message_v1',
     'CREATE OR REPLACE FUNCTION api.send_support_message_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.send_support_message_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.send_support_message_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.send_support_message_v1(%s) IS %L'),
    ('add_support_tag_v1',
     'CREATE OR REPLACE FUNCTION api.add_support_tag_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.add_support_tag_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.add_support_tag_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.add_support_tag_v1(%s) IS %L'),
    ('plugin_submit_v1',
     'CREATE OR REPLACE FUNCTION api.plugin_submit_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.plugin_submit_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.plugin_submit_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.plugin_submit_v1(%s) IS %L'),
    ('plugin_approve_v1',
     'CREATE OR REPLACE FUNCTION api.plugin_approve_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.plugin_approve_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.plugin_approve_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.plugin_approve_v1(%s) IS %L'),
    ('plugin_activate_v1',
     'CREATE OR REPLACE FUNCTION api.plugin_activate_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.plugin_activate_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.plugin_activate_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.plugin_activate_v1(%s) IS %L'),
    ('plugin_set_binding_v1',
     'CREATE OR REPLACE FUNCTION api.plugin_set_binding_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.plugin_set_binding_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.plugin_set_binding_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.plugin_set_binding_v1(%s) IS %L'),
    ('create_feature_flag_v1',
     'CREATE OR REPLACE FUNCTION api.create_feature_flag_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.create_feature_flag_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.create_feature_flag_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.create_feature_flag_v1(%s) IS %L'),
    ('update_feature_flag_v1',
     'CREATE OR REPLACE FUNCTION api.update_feature_flag_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.update_feature_flag_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.update_feature_flag_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.update_feature_flag_v1(%s) IS %L'),
    ('toggle_feature_flag_v1',
     'CREATE OR REPLACE FUNCTION api.toggle_feature_flag_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.toggle_feature_flag_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.toggle_feature_flag_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.toggle_feature_flag_v1(%s) IS %L'),
    ('engage_kill_switch_v1',
     'CREATE OR REPLACE FUNCTION api.engage_kill_switch_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.engage_kill_switch_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.engage_kill_switch_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.engage_kill_switch_v1(%s) IS %L'),
    ('release_kill_switch_v1',
     'CREATE OR REPLACE FUNCTION api.release_kill_switch_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.release_kill_switch_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.release_kill_switch_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.release_kill_switch_v1(%s) IS %L'),
    ('set_rollout_v1',
     'CREATE OR REPLACE FUNCTION api.set_rollout_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.set_rollout_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.set_rollout_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.set_rollout_v1(%s) IS %L'),
    ('bulk_toggle_feature_flags_v1',
     'CREATE OR REPLACE FUNCTION api.bulk_toggle_feature_flags_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.bulk_toggle_feature_flags_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.bulk_toggle_feature_flags_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.bulk_toggle_feature_flags_v1(%s) IS %L'),
    ('pause_alert_rule_v1',
     'CREATE OR REPLACE FUNCTION api.pause_alert_rule_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.pause_alert_rule_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.pause_alert_rule_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.pause_alert_rule_v1(%s) IS %L'),
    ('resume_alert_rule_v1',
     'CREATE OR REPLACE FUNCTION api.resume_alert_rule_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.resume_alert_rule_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.resume_alert_rule_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.resume_alert_rule_v1(%s) IS %L'),
    ('test_alert_rule_v1',
     'CREATE OR REPLACE FUNCTION api.test_alert_rule_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.test_alert_rule_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.test_alert_rule_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.test_alert_rule_v1(%s) IS %L'),
    ('acknowledge_ops_alert_v1',
     'CREATE OR REPLACE FUNCTION api.acknowledge_ops_alert_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.acknowledge_ops_alert_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.acknowledge_ops_alert_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.acknowledge_ops_alert_v1(%s) IS %L'),
    ('resolve_ops_alert_v1',
     'CREATE OR REPLACE FUNCTION api.resolve_ops_alert_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.resolve_ops_alert_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.resolve_ops_alert_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.resolve_ops_alert_v1(%s) IS %L'),
    ('complete_maintenance_v1',
     'CREATE OR REPLACE FUNCTION api.complete_maintenance_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.complete_maintenance_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.complete_maintenance_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.complete_maintenance_v1(%s) IS %L'),
    ('cancel_maintenance_v1',
     'CREATE OR REPLACE FUNCTION api.cancel_maintenance_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.cancel_maintenance_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.cancel_maintenance_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.cancel_maintenance_v1(%s) IS %L'),
    ('record_vehicle_event_v1',
     'CREATE OR REPLACE FUNCTION api.record_vehicle_event_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.record_vehicle_event_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.record_vehicle_event_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.record_vehicle_event_v1(%s) IS %L'),
    ('ui_upsert_provider_auth_config_v1',
     'CREATE OR REPLACE FUNCTION api.ui_upsert_provider_auth_config_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.ui_upsert_provider_auth_config_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.ui_upsert_provider_auth_config_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.ui_upsert_provider_auth_config_v1(%s) IS %L'),
    ('ui_revoke_provider_auth_config_v1',
     'CREATE OR REPLACE FUNCTION api.ui_revoke_provider_auth_config_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.ui_revoke_provider_auth_config_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.ui_revoke_provider_auth_config_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.ui_revoke_provider_auth_config_v1(%s) IS %L'),
    ('integration_plugin_rotate_credentials_v1',
     'CREATE OR REPLACE FUNCTION api.integration_plugin_rotate_credentials_v1(%s) RETURNS %s',
     'REVOKE ALL ON FUNCTION api.integration_plugin_rotate_credentials_v1(%s) FROM PUBLIC, anon',
     'GRANT EXECUTE ON FUNCTION api.integration_plugin_rotate_credentials_v1(%s) TO authenticated, service_role',
     'COMMENT ON FUNCTION api.integration_plugin_rotate_credentials_v1(%s) IS %L')
    ) AS wrappers(name, definition, revoke_acl, grant_acl, description)
  LOOP
    SELECT p.oid,
           p.proname,
           p.pronargs
      INTO f
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname = v_wrapper.name
     ORDER BY p.oid DESC
     LIMIT 1;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'Console V2 api wrapper closure: public.% not found', v_wrapper.name;
    END IF;

    v_args := pg_get_function_arguments(f.oid);
    v_identity_args := pg_get_function_identity_arguments(f.oid);
    v_result := pg_get_function_result(f.oid);
    v_call_args := '';

    IF f.pronargs > 0 THEN
      FOR i IN 1..f.pronargs LOOP
        v_call_args := v_call_args || CASE WHEN i > 1 THEN ', ' ELSE '' END || '$' || i;
      END LOOP;
    END IF;

    v_is_set := (v_result ILIKE 'SETOF %') OR (v_result ILIKE 'TABLE%');
    IF v_is_set THEN
      v_sql := format('SELECT * FROM public.%I(%s);', f.proname, v_call_args);
    ELSE
      v_sql := format('SELECT public.%I(%s);', f.proname, v_call_args);
    END IF;

    EXECUTE format(
      v_wrapper.definition || ' LANGUAGE sql SECURITY DEFINER SET search_path TO public, extensions, pg_temp AS $fn$ %s $fn$',
      v_args,
      v_result,
      v_sql
    );

    EXECUTE format(v_wrapper.revoke_acl, v_identity_args);
    EXECUTE format(v_wrapper.grant_acl, v_identity_args);
    EXECUTE format(
      v_wrapper.description, v_identity_args, 'Console V2 api-schema wrapper for public.' || f.proname || '.'
    );
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202605041345_console_v2_live_contract_closure_v1'));
COMMIT;
