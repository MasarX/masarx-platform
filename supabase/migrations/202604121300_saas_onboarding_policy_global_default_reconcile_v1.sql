BEGIN;

SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB := COALESCE(
    public.resolve_settings('saas_onboarding_policy', public.get_root_scope_type_key_v1(), NULL),
    '{}'::jsonb
  );
BEGIN
  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope_type,
    NULL,
    public.jsonb_deep_merge(
      v_current,
      jsonb_build_object(
        'version', COALESCE(NULLIF(v_current->>'version', '')::INT, 1),
        'enabled', COALESCE((v_current->>'enabled')::BOOLEAN, TRUE),
        'ensure_global_required_defaults', COALESCE((v_current->>'ensure_global_required_defaults')::BOOLEAN, TRUE),
        'materialize_defaults', jsonb_build_object(
          'tenant', jsonb_build_object(
            'use_registry_required_defaults', COALESCE((v_current #>> '{materialize_defaults,tenant,use_registry_required_defaults}')::BOOLEAN, TRUE),
            'strict_required_coverage', COALESCE((v_current #>> '{materialize_defaults,tenant,strict_required_coverage}')::BOOLEAN, TRUE),
            'include_categories', COALESCE(v_current #> '{materialize_defaults,tenant,include_categories}', '[]'::jsonb),
            'exclude_categories', jsonb_build_array(
              'saas_onboarding_policy',
              'workflow_binding_policy',
              'integration_plugin_baseline_policy'
            )
          ),
          'client', jsonb_build_object(
            'use_registry_required_defaults', COALESCE((v_current #>> '{materialize_defaults,client,use_registry_required_defaults}')::BOOLEAN, TRUE),
            'strict_required_coverage', COALESCE((v_current #>> '{materialize_defaults,client,strict_required_coverage}')::BOOLEAN, TRUE),
            'include_categories', COALESCE(v_current #> '{materialize_defaults,client,include_categories}', '[]'::jsonb),
            'exclude_categories', COALESCE(v_current #> '{materialize_defaults,client,exclude_categories}', '[]'::jsonb)
          ),
          'sender', jsonb_build_object(
            'use_registry_required_defaults', COALESCE((v_current #>> '{materialize_defaults,sender,use_registry_required_defaults}')::BOOLEAN, TRUE),
            'strict_required_coverage', COALESCE((v_current #>> '{materialize_defaults,sender,strict_required_coverage}')::BOOLEAN, TRUE),
            'include_categories', COALESCE(v_current #> '{materialize_defaults,sender,include_categories}', '[]'::jsonb),
            'exclude_categories', COALESCE(v_current #> '{materialize_defaults,sender,exclude_categories}', '[]'::jsonb)
          )
        ),
        'workflow_bindings', jsonb_build_object(
          'clone_defaults_for_tenant', COALESCE((v_current #>> '{workflow_bindings,clone_defaults_for_tenant}')::BOOLEAN, TRUE),
          'baseline_profile', COALESCE(NULLIF(v_current #>> '{workflow_bindings,baseline_profile}', ''), 'standard_operations')
        ),
        'integration_plugins', jsonb_build_object(
          'baseline_profile', COALESCE(NULLIF(v_current #>> '{integration_plugins,baseline_profile}', ''), 'standard_operations')
        )
      )
    ),
    1,
    'reconcile saas_onboarding_policy global defaults for onboarding plugin baseline'
  );
END $$;

COMMIT;
