BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261020133000_provider_auth_credential_retirement_v1'));

-- Keep the existing audit policy, including stricter allowlists, secret-safe.
INSERT INTO public.audit_redaction_rules (table_schema, table_name, mode, columns)
VALUES ('public', 'provider_auth_configs', 'denylist', ARRAY['credentials', 'credentials_vault_id'])
ON CONFLICT (table_schema, table_name) DO UPDATE
SET columns = CASE WHEN audit_redaction_rules.mode = 'allowlist' THEN
      array_remove(array_remove(audit_redaction_rules.columns, 'credentials'), 'credentials_vault_id')
    ELSE ARRAY(SELECT DISTINCT value FROM unnest(
      audit_redaction_rules.columns || EXCLUDED.columns) AS value ORDER BY value)
    END;

-- The six arguments are the existing ResourcePage/BulkActions command envelope.
CREATE OR REPLACE FUNCTION public.ui_retire_provider_auth_config_v1(
  p_action_key TEXT,
  p_resource_key TEXT,
  p_selection_ids TEXT[],
  p_selection_id TEXT,
  p_selection_count INTEGER,
  p_params JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_actor UUID := auth.uid();
  v_actor_org UUID := public.current_user_org_id();
  v_id UUID;
  v_reason TEXT := NULLIF(btrim(p_params->>'reason'), '');
  v_config RECORD;
  v_now TIMESTAMPTZ := statement_timestamp();
  v_correlation UUID := gen_random_uuid();
  v_previous_correlation TEXT := current_setting('request.correlation_id', TRUE);
  v_decision UUID;
BEGIN
  IF v_actor IS NULL OR auth.role() IS DISTINCT FROM 'authenticated'
     OR public.request_role_is_service_v1() OR v_actor_org IS NULL THEN
    RAISE EXCEPTION 'Provider credential retirement requires an authenticated organization actor'
      USING ERRCODE = '42501';
  END IF;
  IF p_action_key IS DISTINCT FROM 'provider_auth_configs.retire'
     OR p_resource_key IS DISTINCT FROM 'provider_auth_configs'
     OR cardinality(p_selection_ids) IS DISTINCT FROM 1
     OR p_selection_count IS DISTINCT FROM 1
     OR p_selection_id IS NULL
     OR p_selection_ids[1] IS DISTINCT FROM p_selection_id THEN
    RAISE EXCEPTION 'Provider credential retirement requires one exact configuration selection'
      USING ERRCODE = '22023';
  END IF;
  IF jsonb_typeof(p_params) IS DISTINCT FROM 'object'
     OR jsonb_typeof(p_params->'reason') IS DISTINCT FROM 'string' OR v_reason IS NULL THEN
    RAISE EXCEPTION 'Provider credential retirement requires a reason' USING ERRCODE = '23502';
  END IF;
  v_id := p_selection_id::UUID;
  PERFORM public.assert_capability_v1('integration_plugins.write');
  IF public.user_can_write() IS NOT TRUE THEN
    RAISE EXCEPTION 'Provider credential retirement requires provider write authority'
      USING ERRCODE = '42501';
  END IF;

  SELECT pac.id, pac.provider_id, pac.auth_type, pac.credentials,
         pac.credentials_vault_id, pac.expires_at, p.organization_id
    INTO v_config
    FROM public.provider_auth_configs pac
    JOIN public.providers p ON p.id = pac.provider_id
   WHERE pac.id = v_id
     AND (public.is_platform_user() OR p.organization_id = v_actor_org)
   FOR UPDATE OF pac, p;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Provider credential configuration unavailable' USING ERRCODE = 'P0002';
  END IF;
  -- Match the current providers write policy, not a new inferred *.write grant.
  IF public.user_has_permission_v1('agreements.write', v_config.organization_id) IS NOT TRUE THEN
    RAISE EXCEPTION 'Provider credential retirement requires provider write authority'
      USING ERRCODE = '42501';
  END IF;

  IF v_config.credentials_vault_id IS NULL
     AND v_config.expires_at <= v_now
     AND v_config.credentials->'revoked' = 'true'::JSONB
     AND v_config.credentials ?& ARRAY['revoked_at', 'revoked_by', 'reason', 'correlation_id']
     AND v_config.credentials - ARRAY['revoked', 'revoked_at', 'revoked_by', 'reason', 'correlation_id'] = '{}'::JSONB
     AND v_config.credentials->>'correlation_id' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
    RETURN jsonb_build_object('ok', TRUE, 'changed', FALSE, 'idempotent_no_op', TRUE,
      'provider_auth_config_id', v_id, 'provider_id', v_config.provider_id,
      'expires_at', v_config.expires_at, 'correlation_id', v_config.credentials->>'correlation_id');
  END IF;

  BEGIN
    PERFORM set_config('request.correlation_id', v_correlation::TEXT, TRUE);
    UPDATE public.provider_auth_configs
       SET credentials = jsonb_build_object('revoked', TRUE, 'revoked_at', v_now,
             'revoked_by', v_actor, 'reason', v_reason, 'correlation_id', v_correlation),
           credentials_vault_id = NULL,
           expires_at = v_now
     WHERE id = v_id;

    v_decision := public.log_decision(
      p_organization_id := COALESCE(v_config.organization_id, v_actor_org),
      p_decision_category := 'security',
      p_resource_type := 'provider_auth_config', p_resource_id := v_id,
      p_decision_point := 'provider_auth_config.retire', p_decision_outcome := 'revoked',
      p_performed_by_system := 'ui_retire_provider_auth_config_v1',
      p_correlation_id := v_correlation,
      p_decision_inputs := jsonb_build_object('actor_user_id', v_actor, 'provider_id', v_config.provider_id,
        'auth_type', v_config.auth_type, 'previous_expires_at', v_config.expires_at,
        'expires_at', v_now, 'reason', v_reason),
      p_decision_reason := v_reason);
    PERFORM public.enqueue_domain_event(
      COALESCE(v_config.organization_id, v_actor_org), 'provider_auth_config.revoked',
      'provider_auth_config', v_id,
      jsonb_build_object('actor_user_id', v_actor, 'provider_id', v_config.provider_id,
        'reason', v_reason, 'decision_log_id', v_decision), v_correlation);
    PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
  EXCEPTION WHEN OTHERS THEN
    PERFORM set_config('request.correlation_id', COALESCE(v_previous_correlation, ''), TRUE);
    RAISE;
  END;

  RETURN jsonb_build_object('ok', TRUE, 'changed', TRUE, 'idempotent_no_op', FALSE,
    'provider_auth_config_id', v_id, 'provider_id', v_config.provider_id,
    'expires_at', v_now, 'correlation_id', v_correlation, 'decision_log_id', v_decision);
END;
$function$;

CREATE OR REPLACE FUNCTION api.ui_retire_provider_auth_config_v1(
  p_action_key TEXT, p_resource_key TEXT, p_selection_ids TEXT[],
  p_selection_id TEXT, p_selection_count INTEGER, p_params JSONB
)
RETURNS JSONB LANGUAGE sql SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.ui_retire_provider_auth_config_v1($1, $2, $3, $4, $5, $6);
$function$;

REVOKE ALL ON FUNCTION public.ui_retire_provider_auth_config_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  FROM PUBLIC, anon, service_role;
REVOKE ALL ON FUNCTION api.ui_retire_provider_auth_config_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB)
  FROM PUBLIC, anon, service_role;
GRANT EXECUTE ON FUNCTION public.ui_retire_provider_auth_config_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated;
GRANT EXECUTE ON FUNCTION api.ui_retire_provider_auth_config_v1(TEXT, TEXT, TEXT[], TEXT, INTEGER, JSONB) TO authenticated;

DO $registry$
DECLARE
  v_row RECORD;
  v_version_next JSONB;
  v_pairs_seen INTEGER := 0;
  v_command JSONB := $command${
    "key": "provider_auth_configs.retire",
    "label": "Retire credential",
    "description": "Remove this configuration's usable credentials while preserving its identity and audit history.",
    "capability": "integration_plugins.write",
    "schema_category": "resource:provider_auth_configs",
    "selection": {"mode": "single", "min_count": 1, "max_count": 1},
    "execution": {
      "type": "rpc", "rpc": "ui_retire_provider_auth_config_v1",
      "confirm": {"tone": "danger", "title": "Retire provider credential?"},
      "input_schema": {"version": 1, "fields": [
        {"key": "reason", "label": "Reason (do not include secrets)", "type": "textarea", "required": true}
      ]}
    }
  }$command$::JSONB;
BEGIN
  FOR v_row IN
    SELECT s.id AS settings_id, s.settings_version_id, s.category,
           s.scope_type, s.scope_id, s.scope_hash, s.cached_value,
           sv.schema_version, sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'ui_command_registry'
     FOR UPDATE OF s, sv
  LOOP
    IF jsonb_typeof(v_row.value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.value->'commands') IS DISTINCT FROM 'array'
       OR jsonb_typeof(v_row.cached_value) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_row.cached_value->'commands') IS DISTINCT FROM 'array' THEN
      RAISE EXCEPTION 'ui_command_registry settings pair %/% has invalid commands',
        v_row.settings_id, v_row.settings_version_id;
    END IF;
    v_pairs_seen := v_pairs_seen + 1;
    SELECT jsonb_set(v_row.value, '{commands}',
      COALESCE(jsonb_agg(item ORDER BY ordinality)
        FILTER (WHERE item->>'key' IS DISTINCT FROM v_command->>'key'), '[]'::JSONB)
        || jsonb_build_array(v_command), TRUE)
      INTO v_version_next
      FROM jsonb_array_elements(v_row.value->'commands') WITH ORDINALITY AS entries(item, ordinality);

    IF v_row.value IS DISTINCT FROM v_version_next THEN
      WITH closed AS (
        UPDATE public.settings_versions
           SET effective_until = GREATEST(clock_timestamp(), effective_from + INTERVAL '1 microsecond'),
               updated_at = clock_timestamp()
         WHERE id = v_row.settings_version_id
           AND scope_hash = v_row.scope_hash AND effective_until IS NULL
        RETURNING id
      ), inserted AS (
        INSERT INTO public.settings_versions (
          id, category, scope_type, scope_id, scope_hash, version, value,
          schema_version, change_reason, approved_at, effective_from
        )
        SELECT gen_random_uuid(), v_row.category, v_row.scope_type, v_row.scope_id, v_row.scope_hash,
          (SELECT COALESCE(MAX(candidate.version), 0) + 1 FROM public.settings_versions candidate
            WHERE candidate.category = v_row.category AND candidate.scope_type = v_row.scope_type
              AND candidate.scope_hash = v_row.scope_hash),
          v_version_next, v_row.schema_version, 'Add provider credential retirement action',
          clock_timestamp(), clock_timestamp()
          FROM closed
        RETURNING id, value
      )
      UPDATE public.settings s
         SET settings_version_id = inserted.id, cached_value = inserted.value, last_updated = clock_timestamp()
        FROM inserted
       WHERE s.id = v_row.settings_id AND s.settings_version_id = v_row.settings_version_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'failed to promote ui_command_registry settings pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    ELSIF v_row.cached_value IS DISTINCT FROM v_row.value THEN
      UPDATE public.settings
         SET cached_value = v_row.value, last_updated = clock_timestamp()
       WHERE id = v_row.settings_id AND settings_version_id = v_row.settings_version_id;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'settings cache repair lost pointer CAS for pair %/%',
          v_row.settings_id, v_row.settings_version_id;
      END IF;
    END IF;
  END LOOP;
  IF v_pairs_seen = 0 THEN
    RAISE EXCEPTION 'ui_command_registry settings pairs are missing';
  END IF;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_command_registry:%'
      OR cache_key LIKE 'ui_list_resource:%provider_auth_configs%'
      OR cache_key LIKE 'ui_get_resource:%provider_auth_configs%'
      OR cache_key LIKE 'ui_resource_metrics:%provider_auth_configs%'
      OR cache_key LIKE 'ui_filter_distinct_values:%provider_auth_configs%';
END;
$registry$;

COMMIT;
