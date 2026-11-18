-- Spec-Issue: REAUDIT INTEGRATIONS P0 - canonical webhook_sources upsert RPC
-- Step: B6-RPC-Webhook-Source-Upsert
-- Capability: webhooks.write
--
-- Behavior: idempotent upsert of public.webhook_sources rows.
--   * When p_args->>'source_id' is NULL: CREATE path. Mints a fresh random
--     bearer token (returned ONCE in the envelope; trigger persists only the
--     bcrypt hash via webhook_sources_hash_token). Requires source_identifier,
--     name, provider_type, mapping_config_id.
--   * When p_args->>'source_id' is set: UPDATE path. Only mutates explicitly
--     provided keys. Token is NOT rotated by this RPC; use
--     ui_rotate_webhook_source_token_v1 for that.
--
-- Tenant isolation: writes are scoped to caller's organization (resolved via
-- public.current_user_org_id()) unless caller is platform user.
-- Append-only audit: writes a decision_log row + emits a domain_event on
-- successful create/update.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280300_ui_upsert_webhook_source_v1'));
SET search_path TO public, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.ui_upsert_webhook_source_v1(p_args jsonb)
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
  v_resource_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_target_org UUID;
  v_source_identifier TEXT := NULLIF(btrim(COALESCE(p_args->>'source_identifier', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_provider_type TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'provider_type', '')), ''));
  v_mapping_config_id UUID := NULLIF(p_args->>'mapping_config_id', '')::uuid;
  v_rate_limit INTEGER := NULLIF(p_args->>'rate_limit_per_hour', '')::int;
  v_enabled_present BOOLEAN := (p_args ? 'enabled');
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_before public.webhook_sources%ROWTYPE;
  v_minted_token TEXT;
  v_action TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    -- CREATE path: required fields
    IF v_source_identifier IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires source_identifier on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires name on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_provider_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires provider_type on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_mapping_config_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires mapping_config_id on create'
        USING ERRCODE = '23502';
    END IF;

    v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 cannot resolve target organization'
        USING ERRCODE = '23502';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 organization_id outside tenant scope'
        USING ERRCODE = '42501';
    END IF;

    -- Mint fresh bearer token (one-time-view; trigger hashes to auth_token_hash).
    v_minted_token := encode(gen_random_bytes(32), 'hex');

    INSERT INTO public.webhook_sources (
      organization_id, source_identifier, name, provider_type,
      auth_token, mapping_config_id, rate_limit_per_hour, enabled
    ) VALUES (
      v_target_org, v_source_identifier, v_name, v_provider_type,
      v_minted_token, v_mapping_config_id, COALESCE(v_rate_limit, 1000), v_enabled
    )
    RETURNING id INTO v_resource_id;

    v_action := 'created';
  ELSE
    -- UPDATE path: load + tenant-scope guard, then partial mutation
    SELECT * INTO v_before FROM public.webhook_sources WHERE id = v_resource_id FOR UPDATE;
    IF v_before.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % not found', v_resource_id
        USING ERRCODE = '23503';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_before.organization_id <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % outside tenant scope', v_resource_id
        USING ERRCODE = '42501';
    END IF;

    v_target_org := v_before.organization_id;

    UPDATE public.webhook_sources
       SET source_identifier = COALESCE(v_source_identifier, source_identifier),
           name = COALESCE(v_name, name),
           provider_type = COALESCE(v_provider_type, provider_type),
           mapping_config_id = COALESCE(v_mapping_config_id, mapping_config_id),
           rate_limit_per_hour = COALESCE(v_rate_limit, rate_limit_per_hour),
           enabled = CASE WHEN v_enabled_present THEN v_enabled ELSE enabled END,
           updated_at = now()
     WHERE id = v_resource_id;

    v_action := 'updated';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.upsert_source', 'webhook_source', v_resource_id,
    'ui_upsert_webhook_source_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_source_identifier,
      'name', v_name,
      'provider_type', v_provider_type,
      'mapping_config_id', v_mapping_config_id,
      'rate_limit_per_hour', v_rate_limit,
      'enabled', CASE WHEN v_enabled_present THEN to_jsonb(v_enabled) ELSE NULL END
    )),
    'ui_upsert_webhook_source_v1', v_correlation_id::uuid
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'webhook_source.' || v_action, 'webhook_source', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object(
        'source_identifier', v_source_identifier,
        'name', v_name,
        'provider_type', v_provider_type
      )),
      v_correlation_id::uuid, 'pending'
    );
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'webhook_source_id', v_resource_id,
    'action', v_action,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$$;

REVOKE ALL ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb)
  IS 'Canonical write RPC: insert or update public.webhook_sources. Capability: webhooks.write. On create, mints fresh auth_token (returned ONCE; trigger persists hash only).';

SELECT pg_advisory_unlock(hashtext('202604280300_ui_upsert_webhook_source_v1'));
COMMIT;
