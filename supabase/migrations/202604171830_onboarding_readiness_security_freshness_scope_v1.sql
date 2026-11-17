-- Plan: PLAN-202604-onboarding-readiness-plugin-baseline-closure / Step: S93
-- Purpose:
-- - Close onboarding readiness contract gaps by validating workflow baselines
--   through the canonical workflow binding resolver for tenant, client, and sender
--   scopes.
-- - Return a DB-backed generated_at timestamp so UI freshness is evidence-backed.
-- - Restrict direct helper execution to service_role; authenticated users must go
--   through the UI wrapper with capability checks.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604171830_onboarding_readiness_security_freshness_scope_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.onboarding_readiness_snapshot_v1(
  p_scope_type TEXT,
  p_scope_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_scope_id UUID := p_scope_id;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_org_id UUID := public.resolve_organization_id_for_scope_v1(v_scope_type, v_scope_id);
  v_client_id UUID := NULL;
  v_scope_context JSONB := '{}'::jsonb;
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_generated_at TIMESTAMPTZ := now();
  v_blocking_findings JSONB := '[]'::jsonb;
  v_settings_missing JSONB := '[]'::jsonb;
  v_settings_required_count INT := 0;
  v_settings_present_count INT := 0;
  v_workflow_missing JSONB := '[]'::jsonb;
  v_workflow_required_count INT := 0;
  v_workflow_present_count INT := 0;
  v_workflow_status TEXT := 'healthy';
  v_plugin_status JSONB := '{}'::jsonb;
  v_plugin_items JSONB := '[]'::jsonb;
  v_plugin_findings JSONB := '[]'::jsonb;
  v_plugin_blocking_count INT := 0;
  v_plugin_pending_count INT := 0;
  v_plugin_healthy_count INT := 0;
  v_plugin_required_count INT := 0;
  v_category RECORD;
  v_binding RECORD;
  v_stage RECORD;
  v_template_status TEXT;
  v_workflow_baseline_policy JSONB := '{}'::jsonb;
  v_workflow_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['workflow_bindings', 'baseline_profile']), ''),
    'default'
  );
  v_integration_baseline_profile TEXT := COALESCE(
    NULLIF(btrim(v_policy #>> ARRAY['integration_plugins', 'baseline_profile']), ''),
    'default'
  );
  v_workflow_resolution RECORD;
  v_overall_status TEXT;
BEGIN
  IF v_scope_type = 'client' THEN
    v_client_id := v_scope_id;
  ELSIF v_scope_type = 'sender' THEN
    SELECT s.client_id
      INTO v_client_id
      FROM public.senders s
     WHERE s.id = v_scope_id
     LIMIT 1;
  END IF;

  v_scope_context := jsonb_strip_nulls(
    jsonb_build_object(
      'organization_id', v_org_id,
      'client_id', v_client_id,
      'sender_id', CASE WHEN v_scope_type = 'sender' THEN v_scope_id ELSE NULL END
    )
  );

  FOR v_category IN
    SELECT c.category
    FROM public.onboarding_policy_categories_v1(v_policy, v_scope_type) AS c
  LOOP
    v_settings_required_count := v_settings_required_count + 1;

    IF EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = v_category.category
        AND s.scope_type = v_scope_type
        AND s.scope_id IS NOT DISTINCT FROM v_scope_id
    ) THEN
      v_settings_present_count := v_settings_present_count + 1;
    ELSE
      v_settings_missing := v_settings_missing || jsonb_build_array(v_category.category);
      v_blocking_findings := v_blocking_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'settings_defaults',
          'code', 'missing_scope_default',
          'category', v_category.category,
          'message', format(
            'Required onboarding default %s is missing for %s/%s.',
            v_category.category,
            v_scope_type,
            COALESCE(v_scope_id::text, 'global')
          )
        )
      );
    END IF;
  END LOOP;

  v_workflow_baseline_policy := COALESCE(
    public.workflow_binding_policy_baseline_v1(),
    public.workflow_binding_policy_default_v1()
  );

  FOR v_binding IN
    SELECT key, value
    FROM jsonb_each(COALESCE(v_workflow_baseline_policy->'bindings', '{}'::jsonb))
  LOOP
    FOR v_stage IN
      SELECT key, value
      FROM jsonb_each(COALESCE(v_binding.value->'stages', '{}'::jsonb))
    LOOP
      v_workflow_required_count := v_workflow_required_count + 1;

      SELECT *
        INTO v_workflow_resolution
        FROM public.resolve_workflow_binding_v1(v_binding.key, v_stage.key, v_scope_context)
       LIMIT 1;

      IF NOT FOUND
         OR v_workflow_resolution.workflow_template_id IS NULL
         OR v_workflow_resolution.stage_value IS NULL THEN
        v_workflow_missing := v_workflow_missing || jsonb_build_array(
          jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
        );
        v_blocking_findings := v_blocking_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'workflow_bindings',
            'code', 'missing_workflow_binding_stage',
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'message', format(
              'Workflow binding %s/%s is missing from the effective onboarding defaults for %s/%s.',
              v_binding.key,
              v_stage.key,
              v_scope_type,
              COALESCE(v_scope_id::text, 'global')
            )
          )
        );
        v_workflow_status := 'blocked';
        CONTINUE;
      END IF;

      IF COALESCE(v_workflow_resolution.enabled, FALSE) IS FALSE THEN
        v_workflow_missing := v_workflow_missing || jsonb_build_array(
          jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
        );
        v_blocking_findings := v_blocking_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'workflow_bindings',
            'code', 'disabled_workflow_binding_stage',
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'message', format(
              'Workflow binding %s/%s is disabled for %s/%s.',
              v_binding.key,
              v_stage.key,
              v_scope_type,
              COALESCE(v_scope_id::text, 'global')
            )
          )
        );
        v_workflow_status := 'blocked';
        CONTINUE;
      END IF;

      IF v_scope_type = 'tenant' THEN
        IF COALESCE(v_workflow_resolution.workflow_template_scope_type, '') <> 'tenant'
           OR v_workflow_resolution.workflow_template_scope_id IS DISTINCT FROM v_scope_id THEN
          v_workflow_missing := v_workflow_missing || jsonb_build_array(
            jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
          );
          v_blocking_findings := v_blocking_findings || jsonb_build_array(
            jsonb_build_object(
              'severity', 'blocking',
              'component', 'workflow_bindings',
              'code', 'workflow_template_scope_mismatch',
              'binding_key', v_binding.key,
              'stage_key', v_stage.key,
              'message', format(
                'Workflow binding %s/%s must resolve to a tenant-scoped cloned template for %s, but resolved to %s/%s.',
                v_binding.key,
                v_stage.key,
                COALESCE(v_scope_id::text, 'global'),
                COALESCE(v_workflow_resolution.workflow_template_scope_type, 'unknown'),
                COALESCE(v_workflow_resolution.workflow_template_scope_id::text, 'global')
              )
            )
          );
          v_workflow_status := 'blocked';
          CONTINUE;
        END IF;
      ELSIF (
        COALESCE(v_workflow_resolution.workflow_template_scope_type, '') = ''
        OR v_workflow_resolution.workflow_template_scope_type = v_root_scope_type
        OR v_workflow_resolution.workflow_template_scope_id IS NULL
        OR (
          v_scope_type = 'client'
          AND v_workflow_resolution.workflow_template_scope_type NOT IN ('tenant', 'client')
        )
        OR (
          v_scope_type = 'sender'
          AND v_workflow_resolution.workflow_template_scope_type NOT IN ('tenant', 'client', 'sender')
        )
      ) THEN
        v_workflow_missing := v_workflow_missing || jsonb_build_array(
          jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
        );
        v_blocking_findings := v_blocking_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'workflow_bindings',
            'code', 'workflow_template_scope_mismatch',
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'message', format(
              'Workflow binding %s/%s resolved to %s/%s for %s/%s. Effective onboarding defaults must not fall back to a global template.',
              v_binding.key,
              v_stage.key,
              COALESCE(v_workflow_resolution.workflow_template_scope_type, 'unknown'),
              COALESCE(v_workflow_resolution.workflow_template_scope_id::text, 'global'),
              v_scope_type,
              COALESCE(v_scope_id::text, 'global')
            )
          )
        );
        v_workflow_status := 'blocked';
        CONTINUE;
      END IF;

      SELECT wt.status
        INTO v_template_status
        FROM public.workflow_templates wt
       WHERE wt.id = v_workflow_resolution.workflow_template_id
       LIMIT 1;

      IF COALESCE(v_template_status, '') <> 'active' THEN
        v_workflow_missing := v_workflow_missing || jsonb_build_array(
          jsonb_build_object('binding_key', v_binding.key, 'stage_key', v_stage.key)
        );
        v_blocking_findings := v_blocking_findings || jsonb_build_array(
          jsonb_build_object(
            'severity', 'blocking',
            'component', 'workflow_bindings',
            'code', 'inactive_workflow_template',
            'binding_key', v_binding.key,
            'stage_key', v_stage.key,
            'message', format(
              'Workflow binding %s/%s does not resolve to an active template for %s/%s.',
              v_binding.key,
              v_stage.key,
              v_scope_type,
              COALESCE(v_scope_id::text, 'global')
            )
          )
        );
        v_workflow_status := 'blocked';
      ELSE
        v_workflow_present_count := v_workflow_present_count + 1;
      END IF;
    END LOOP;
  END LOOP;

  v_plugin_status := public.onboarding_integration_plugin_readiness_v1(v_scope_type, v_scope_id);
  v_plugin_items := COALESCE(v_plugin_status->'items', '[]'::jsonb);
  v_plugin_findings := COALESCE(v_plugin_status->'blocking_findings', '[]'::jsonb);
  v_plugin_blocking_count := COALESCE((v_plugin_status->>'blocking_count')::int, 0);
  v_plugin_pending_count := COALESCE((v_plugin_status->>'pending_credentials_count')::int, 0);

  SELECT COUNT(*)
    INTO v_plugin_required_count
    FROM public.onboarding_integration_plugin_defaults d
   WHERE d.enabled = TRUE
     AND d.profile_key = v_integration_baseline_profile
     AND d.scope_type = v_scope_type;

  SELECT COUNT(*)
    INTO v_plugin_healthy_count
    FROM jsonb_array_elements(v_plugin_items) AS item(value)
   WHERE lower(COALESCE(item.value->>'status', '')) = 'healthy';

  v_blocking_findings := v_blocking_findings || v_plugin_findings;

  IF jsonb_array_length(v_blocking_findings) > 0 THEN
    v_overall_status := 'blocked';
  ELSIF v_plugin_pending_count > 0 THEN
    v_overall_status := 'pending_credentials';
  ELSE
    v_overall_status := 'healthy';
  END IF;

  RETURN jsonb_build_object(
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'organization_id', v_org_id,
    'generated_at', v_generated_at,
    'overall_status', v_overall_status,
    'healthy', v_overall_status = 'healthy',
    'settings_defaults', jsonb_build_object(
      'status', CASE
        WHEN v_settings_required_count = 0 OR jsonb_array_length(v_settings_missing) = 0 THEN 'healthy'
        ELSE 'blocked'
      END,
      'healthy', v_settings_required_count = 0 OR jsonb_array_length(v_settings_missing) = 0,
      'required_count', v_settings_required_count,
      'present_count', v_settings_present_count,
      'missing_categories', v_settings_missing
    ),
    'workflow_bindings', jsonb_build_object(
      'status', v_workflow_status,
      'healthy', v_workflow_status IN ('healthy', 'not_applicable'),
      'baseline_profile', v_workflow_baseline_profile,
      'required_count', v_workflow_required_count,
      'present_count', v_workflow_present_count,
      'missing_stages', v_workflow_missing
    ),
    'integration_plugins', jsonb_build_object(
      'status', CASE
        WHEN v_plugin_blocking_count > 0 THEN 'blocked'
        WHEN v_plugin_pending_count > 0 THEN 'pending_credentials'
        ELSE 'healthy'
      END,
      'healthy', v_plugin_blocking_count = 0 AND v_plugin_pending_count = 0,
      'baseline_profile', v_integration_baseline_profile,
      'required_count', v_plugin_required_count,
      'healthy_count', v_plugin_healthy_count,
      'pending_credentials_count', v_plugin_pending_count,
      'blocking_count', v_plugin_blocking_count,
      'items', v_plugin_items
    ),
    'blocking_findings', v_blocking_findings
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID) FROM PUBLIC, anon;

GRANT EXECUTE ON FUNCTION public.onboarding_integration_plugin_readiness_v1(TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.ui_get_onboarding_readiness_v1(TEXT, UUID)
  TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION api.ui_get_onboarding_readiness_v1(TEXT, UUID)
  TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604171830_onboarding_readiness_security_freshness_scope_v1'));
COMMIT;
