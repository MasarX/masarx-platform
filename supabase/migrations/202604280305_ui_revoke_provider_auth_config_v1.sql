-- Spec-Issue: REAUDIT INTEGRATIONS P0 - canonical provider_auth_configs revoke RPC
-- Step: B6-RPC-Provider-Auth-Revoke
-- Capability: integration_plugins.write (the canonical SSOT for plugin-bound
--   credentials; FE surfaces this via the umbrella `integrations.write` per
--   FE_ONLY_PENDING in apps/console-v2/scripts/lint-capabilities.mjs:168).
--
-- Behavior: revokes a public.provider_auth_configs credential by setting
-- expires_at = now() and clearing credentials (replaces with tombstone JSONB
-- so the column NOT NULL constraint is satisfied while opaque secret payload
-- is purged). The FE derives "status: revoked" from expires_at <= now() and
-- credentials.revoked = true.
--
-- Tenant isolation: the parent provider's organization_id is the scope. Append
-- only audit: writes a decision_log row + emits a domain_event.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280305_ui_revoke_provider_auth_config_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_revoke_provider_auth_config_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'config_id', '')::uuid;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_before public.provider_auth_configs%ROWTYPE;
  v_target_org UUID;
  v_already_revoked BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_revoke_provider_auth_config_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.write');

  IF v_resource_id IS NULL THEN
    RAISE EXCEPTION 'ui_revoke_provider_auth_config_v1 requires config_id'
      USING ERRCODE = '23502';
  END IF;

  SELECT * INTO v_before FROM public.provider_auth_configs WHERE id = v_resource_id FOR UPDATE;
  IF v_before.id IS NULL THEN
    RAISE EXCEPTION 'ui_revoke_provider_auth_config_v1 provider_auth_config % not found', v_resource_id
      USING ERRCODE = '23503';
  END IF;

  SELECT organization_id INTO v_target_org
    FROM public.providers
   WHERE id = v_before.provider_id;
  IF v_org_id IS NOT NULL
     AND v_target_org IS NOT NULL
     AND v_target_org <> v_org_id
     AND NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'ui_revoke_provider_auth_config_v1 provider_auth_config % outside tenant scope', v_resource_id
      USING ERRCODE = '42501';
  END IF;

  v_already_revoked := COALESCE((v_before.credentials->>'revoked')::boolean, FALSE);

  IF NOT v_already_revoked THEN
    -- Replace any vault-stored or legacy plaintext credentials with a
    -- tombstone JSONB. Clear credentials_vault_id so the only credential
    -- source is the tombstone (the credentials_present constraint is
    -- satisfied because the JSONB is non-null).
    UPDATE public.provider_auth_configs
       SET credentials = jsonb_build_object(
             'revoked', true,
             'revoked_at', to_jsonb(now()),
             'revoked_by', to_jsonb(v_user_id),
             'reason', to_jsonb(v_reason)
           ),
           credentials_vault_id = NULL,
           expires_at = now()
     WHERE id = v_resource_id;
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'integrations.revoke_credential', 'provider_auth_config', v_resource_id,
    'ui_revoke_provider_auth_config_v1',
    CASE WHEN v_already_revoked THEN 'no_op' ELSE 'revoked' END,
    jsonb_strip_nulls(jsonb_build_object(
      'provider_id', v_before.provider_id,
      'auth_type', v_before.auth_type,
      'reason', v_reason
    )),
    'ui_revoke_provider_auth_config_v1', v_correlation_id::uuid
  );

  IF NOT v_already_revoked AND v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'provider_auth_config.revoked', 'provider_auth_config', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object(
        'provider_id', v_before.provider_id,
        'reason', v_reason
      )),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'provider_auth_config_id', v_resource_id,
    'idempotent_no_op', v_already_revoked,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.ui_revoke_provider_auth_config_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_revoke_provider_auth_config_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_revoke_provider_auth_config_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ui_revoke_provider_auth_config_v1(jsonb)
  IS 'Canonical write RPC: revoke a provider_auth_configs credential (idempotent; sets expires_at=now and credentials=tombstone). Capability: integration_plugins.write.';

SELECT pg_advisory_unlock(hashtext('202604280305_ui_revoke_provider_auth_config_v1'));
COMMIT;
