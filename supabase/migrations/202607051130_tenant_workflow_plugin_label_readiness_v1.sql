-- Migration: Tenant workflow/plugin/label readiness readback
-- Purpose:
--   Add label design and renderer readiness to the existing onboarding
--   readiness snapshot so first-tenant configuration can be proven as one
--   row-driven workflow/plugin/label journey.

BEGIN;

SELECT pg_advisory_lock(hashtext('202607051130_tenant_workflow_plugin_label_readiness_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET schema = jsonb_set(
         COALESCE(schema, '{}'::jsonb),
         '{properties,label_design}',
         jsonb_build_object(
           'type', 'object',
           'additionalProperties', TRUE,
           'properties', jsonb_build_object(
             'required_categories', jsonb_build_object(
               'type', 'array',
               'items', jsonb_build_object('type', 'string')
             ),
             'require_renderer_provider', jsonb_build_object('type', 'boolean'),
             'require_printer_certification', jsonb_build_object('type', 'boolean')
           )
         ),
         TRUE
       ),
       updated_at = now()
 WHERE category = 'saas_onboarding_policy'
   AND is_active = TRUE;

DO $do$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_patch JSONB := jsonb_build_object(
    'label_design', jsonb_build_object(
      'required_categories', jsonb_build_array('label_design', 'label_render_policy', 'label_print_profile'),
      'require_renderer_provider', TRUE,
      'require_printer_certification', FALSE
    )
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = public.get_root_scope_type_key_v1()
     AND s.scope_id IS NULL
   LIMIT 1;

  v_next := public.jsonb_deep_merge(COALESCE(v_current, '{}'::jsonb), v_patch);

  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    public.get_root_scope_type_key_v1(),
    NULL,
    v_next,
    1,
    'Extend onboarding readiness with label design component'
  );
END;
$do$;

CREATE OR REPLACE FUNCTION public.onboarding_label_design_readiness_v1(
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
  v_required JSONB := COALESCE(
    v_policy #> ARRAY['label_design', 'required_categories'],
    jsonb_build_array('label_design', 'label_render_policy', 'label_print_profile')
  );
  v_require_renderer BOOLEAN := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['label_design', 'require_renderer_provider'],
    TRUE
  );
  v_require_certification BOOLEAN := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['label_design', 'require_printer_certification'],
    FALSE
  );
  v_category TEXT;
  v_row RECORD;
  v_value JSONB;
  v_items JSONB := '[]'::jsonb;
  v_missing JSONB := '[]'::jsonb;
  v_findings JSONB := '[]'::jsonb;
  v_required_count INT := 0;
  v_present_count INT := 0;
  v_healthy_count INT := 0;
  v_blocking_count INT := 0;
  v_warning_count INT := 0;
  v_status TEXT;
  v_provider JSONB := '{}'::jsonb;
  v_provider_status TEXT := 'not_required';
  v_provider_error TEXT;
  v_print_profile JSONB := '{}'::jsonb;
  v_certification JSONB;
BEGIN
  IF jsonb_typeof(v_required) <> 'array' THEN
    v_required := jsonb_build_array('label_design', 'label_render_policy', 'label_print_profile');
  END IF;

  FOR v_category IN
    SELECT DISTINCT NULLIF(btrim(value), '')
    FROM jsonb_array_elements_text(v_required)
    WHERE NULLIF(btrim(value), '') IS NOT NULL
    ORDER BY 1
  LOOP
    v_required_count := v_required_count + 1;
    v_value := NULL;

    BEGIN
      SELECT *
        INTO v_row
        FROM public.resolve_settings_row(v_category, v_scope_type, v_scope_id)
       LIMIT 1;
      v_value := v_row.value;
    EXCEPTION WHEN OTHERS THEN
      v_value := NULL;
    END;

    IF v_value IS NULL OR jsonb_typeof(v_value) <> 'object' THEN
      v_missing := v_missing || jsonb_build_array(v_category);
      v_blocking_count := v_blocking_count + 1;
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'label_design',
          'code', 'missing_label_design_setting',
          'category', v_category,
          'message', format(
            'Required label readiness setting %s is missing for %s/%s.',
            v_category,
            v_scope_type,
            COALESCE(v_scope_id::text, 'global')
          )
        )
      );
      v_items := v_items || jsonb_build_array(
        jsonb_build_object('category', v_category, 'status', 'missing')
      );
      CONTINUE;
    END IF;

    v_present_count := v_present_count + 1;

    IF v_category = 'label_design' AND jsonb_typeof(v_value->'templates') <> 'object' THEN
      v_blocking_count := v_blocking_count + 1;
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'label_design',
          'code', 'label_design_templates_missing',
          'category', v_category,
          'message', 'Effective label design is missing its templates object.'
        )
      );
      v_items := v_items || jsonb_build_array(
        jsonb_build_object('category', v_category, 'status', 'blocked', 'winning_scope_type', v_row.scope_type)
      );
      CONTINUE;
    END IF;

    IF v_category = 'label_render_policy' AND NULLIF(v_value->>'header_brand_mode', '') IS NULL THEN
      v_blocking_count := v_blocking_count + 1;
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'label_design',
          'code', 'label_render_policy_brand_mode_missing',
          'category', v_category,
          'message', 'Effective label render policy is missing header_brand_mode.'
        )
      );
      v_items := v_items || jsonb_build_array(
        jsonb_build_object('category', v_category, 'status', 'blocked', 'winning_scope_type', v_row.scope_type)
      );
      CONTINUE;
    END IF;

    IF v_category = 'label_print_profile'
       AND (
         NULLIF(v_value->>'profile_key', '') IS NULL
         OR NULLIF(v_value->>'dpi', '') IS NULL
       ) THEN
      v_blocking_count := v_blocking_count + 1;
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'label_design',
          'code', 'label_print_profile_incomplete',
          'category', v_category,
          'message', 'Effective label print profile is missing profile_key or dpi.'
        )
      );
      v_items := v_items || jsonb_build_array(
        jsonb_build_object('category', v_category, 'status', 'blocked', 'winning_scope_type', v_row.scope_type)
      );
      CONTINUE;
    END IF;

    v_healthy_count := v_healthy_count + 1;
    v_items := v_items || jsonb_build_array(
      jsonb_strip_nulls(
        jsonb_build_object(
          'category', v_category,
          'status', 'ready',
          'winning_scope_type', v_row.scope_type,
          'winning_scope_id', v_row.scope_id,
          'settings_version_id', v_row.settings_version_id
        )
      )
    );

    IF v_category = 'label_print_profile' THEN
      v_print_profile := v_value;
    END IF;
  END LOOP;

  IF v_require_renderer THEN
    BEGIN
      v_provider := public.resolve_label_renderer_invoke_config_v1(v_org_id);
      v_provider_status := 'ready';
    EXCEPTION WHEN OTHERS THEN
      v_provider_error := SQLERRM;
      v_provider_status := 'missing';
      v_warning_count := v_warning_count + 1;
    END;
  END IF;

  v_certification := COALESCE(
    v_print_profile->'printer_certification',
    v_print_profile->'certification',
    v_print_profile->'certified_printers',
    v_print_profile#>'{media,certification}'
  );
  IF v_certification IS NULL OR v_certification = '{}'::jsonb OR v_certification = '[]'::jsonb THEN
    IF v_require_certification THEN
      v_blocking_count := v_blocking_count + 1;
      v_findings := v_findings || jsonb_build_array(
        jsonb_build_object(
          'severity', 'blocking',
          'component', 'label_design',
          'code', 'printer_certification_missing',
          'message', 'Printer certification evidence is required by onboarding policy.'
        )
      );
    ELSE
      v_warning_count := v_warning_count + 1;
    END IF;
  END IF;

  v_status := CASE
    WHEN v_blocking_count > 0 THEN 'blocked'
    WHEN v_warning_count > 0 THEN 'warning'
    ELSE 'healthy'
  END;

  RETURN jsonb_build_object(
    'status', v_status,
    'healthy', v_status = 'healthy',
    'required_count', v_required_count,
    'present_count', v_present_count,
    'healthy_count', v_healthy_count,
    'blocking_count', v_blocking_count,
    'warning_count', v_warning_count,
    'missing_categories', v_missing,
    'renderer_provider_status', v_provider_status,
    'renderer_provider', jsonb_strip_nulls(
      jsonb_build_object(
        'status', v_provider_status,
        'provider_name', NULLIF(v_provider->>'provider_name', ''),
        'invoke_url', CASE WHEN NULLIF(v_provider->>'invoke_url', '') IS NULL THEN NULL ELSE 'configured' END,
        'invoke_secret', CASE WHEN NULLIF(v_provider->>'invoke_secret', '') IS NULL THEN NULL ELSE 'redacted' END,
        'error', v_provider_error
      )
    ),
    'printer_certification_status', CASE
      WHEN v_certification IS NULL OR v_certification = '{}'::jsonb OR v_certification = '[]'::jsonb THEN 'missing'
      ELSE 'ready'
    END,
    'items', v_items,
    'blocking_findings', v_findings
  );
END;
$function$;

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
  v_label_status JSONB := '{}'::jsonb;
  v_label_findings JSONB := '[]'::jsonb;
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

  v_label_status := public.onboarding_label_design_readiness_v1(v_scope_type, v_scope_id);
  v_label_findings := COALESCE(v_label_status->'blocking_findings', '[]'::jsonb);

  v_blocking_findings := v_blocking_findings || v_plugin_findings || v_label_findings;

  IF jsonb_array_length(v_blocking_findings) > 0 THEN
    v_overall_status := 'blocked';
  ELSIF v_plugin_pending_count > 0 THEN
    v_overall_status := 'pending_credentials';
  ELSIF COALESCE(v_label_status->>'status', '') = 'warning' THEN
    v_overall_status := 'warning';
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
    'label_design', v_label_status - 'blocking_findings',
    'blocking_findings', v_blocking_findings
  );
END;
$function$;

COMMENT ON FUNCTION public.onboarding_label_design_readiness_v1(TEXT, UUID)
  IS 'Returns row-driven onboarding label design, render policy, print profile, renderer provider, and printer certification readiness without exposing provider secrets.';

COMMENT ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID)
  IS 'Returns row-driven onboarding readiness across settings defaults, workflow bindings, integration plugins, and label design readiness.';

REVOKE ALL ON FUNCTION public.onboarding_label_design_readiness_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.onboarding_label_design_readiness_v1(TEXT, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.onboarding_readiness_snapshot_v1(TEXT, UUID) TO service_role;

SELECT pg_advisory_unlock(hashtext('202607051130_tenant_workflow_plugin_label_readiness_v1'));

COMMIT;
