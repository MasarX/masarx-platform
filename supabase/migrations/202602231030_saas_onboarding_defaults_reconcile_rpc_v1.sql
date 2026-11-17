-- Migration: SaaS onboarding defaults reconcile RPC (maintenance)
-- Purpose:
--   - Provide an idempotent maintenance RPC to reconcile required defaults for
--     existing scopes after pre-GA resets/rebaseline.
--   - Keep onboarding defaults/materialization policy-driven through
--     resolve_saas_onboarding_policy_v1 + bootstrap_scope_settings_defaults_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602231030_saas_onboarding_defaults_reconcile_rpc_v1'));

CREATE OR REPLACE FUNCTION public.reconcile_saas_onboarding_defaults_v1(
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL,
  p_trigger_source TEXT DEFAULT 'manual:reconcile_saas_onboarding_defaults_v1'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := lower(btrim(COALESCE(p_scope_type, '')));
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_global_result JSONB := public.ensure_required_global_defaults_v1();
  v_scope_result JSONB := '{}'::jsonb;
  v_provision_templates BOOLEAN;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
BEGIN
  IF v_scope_type = '' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'scope_type', NULL,
      'scope_id', NULL,
      'global_defaults', v_global_result,
      'scope_defaults', NULL
    );
  END IF;

  IF v_scope_type = 'global' THEN
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=global requires NULL scope_id';
    END IF;
    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'global',
      NULL,
      v_policy,
      p_trigger_source
    );
  ELSIF v_scope_type = 'tenant' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=tenant requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.organizations WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 tenant % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'tenant',
      p_scope_id,
      v_policy,
      p_trigger_source
    );

    v_provision_templates := public.onboarding_policy_bool_v1(v_policy, ARRAY['rbac', 'provision_templates'], TRUE);
    IF v_provision_templates THEN
      v_template_keys_json := COALESCE(v_policy #> ARRAY['rbac', 'template_keys'], '[]'::jsonb);
      IF jsonb_typeof(v_template_keys_json) <> 'array' THEN
        v_template_keys_json := '[]'::jsonb;
      END IF;

      SELECT COALESCE(array_agg(value), ARRAY[]::TEXT[])
        INTO v_template_keys
        FROM jsonb_array_elements_text(v_template_keys_json);

      IF array_length(v_template_keys, 1) IS NOT NULL THEN
        PERFORM public.provision_rbac_roles_from_templates_v1(
          p_scope_id,
          v_template_keys,
          NULL
        );
      END IF;
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=client requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.clients WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 client % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'client',
      p_scope_id,
      v_policy,
      p_trigger_source
    );
  ELSIF v_scope_type = 'sender' THEN
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 scope_type=sender requires non-NULL scope_id';
    END IF;

    PERFORM 1 FROM public.senders WHERE id = p_scope_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 sender % not found', p_scope_id USING ERRCODE = '23503';
    END IF;

    v_scope_result := public.bootstrap_scope_settings_defaults_v1(
      'sender',
      p_scope_id,
      v_policy,
      p_trigger_source
    );
  ELSE
    RAISE EXCEPTION 'reconcile_saas_onboarding_defaults_v1 unsupported scope_type=%', p_scope_type;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'global_defaults', v_global_result,
    'scope_defaults', v_scope_result
  );
END;
$function$;

COMMENT ON FUNCTION public.reconcile_saas_onboarding_defaults_v1(TEXT, UUID, TEXT)
IS 'Idempotent maintenance reconcile for required onboarding defaults across global/tenant/client/sender scopes.';

REVOKE ALL ON FUNCTION public.reconcile_saas_onboarding_defaults_v1(TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.reconcile_saas_onboarding_defaults_v1(TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.reconcile_saas_onboarding_defaults_v1(TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.reconcile_saas_onboarding_defaults_v1(TEXT, UUID, TEXT) TO service_role;

SELECT pg_advisory_unlock(hashtext('202602231030_saas_onboarding_defaults_reconcile_rpc_v1'));
COMMIT;
