-- Migration: Onboarding Mobile V2 shell policy tenant defaults
-- Purpose: Keep the global Mobile shell fallback fail-closed while ensuring
-- tenant onboarding/bootstrap materializes a disabled rollout policy for
-- real tenant scopes through the existing saas_onboarding_policy path.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605300115_onboarding_mobile_v2_shell_policy_defaults_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

CREATE OR REPLACE FUNCTION public.resolve_saas_onboarding_policy_v1()
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'ensure_global_required_defaults', TRUE,
    'materialize_defaults', jsonb_build_object(
      'tenant', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'strict_required_coverage', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('saas_onboarding_policy'),
        'category_value_overrides', jsonb_build_object(
          'mobile_shell_policy', jsonb_build_object(
            'version', 1,
            'v2_enabled', FALSE
          )
        )
      ),
      'client', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      ),
      'sender', jsonb_build_object(
        'use_registry_required_defaults', FALSE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array()
      )
    ),
    'rbac', jsonb_build_object(
      'provision_templates', TRUE,
      'template_keys', jsonb_build_array(
        'ops_admin',
        'finance',
        'agreements_admin',
        'fleet_manager',
        'warehouse_operator',
        'driver'
      )
    ),
    'client_defaults', jsonb_build_object(
      'create_default_sender', TRUE,
      'default_sender_name', 'Default Sender',
      'default_sender_brand_name', NULL
    )
  );
  v_resolved JSONB;
BEGIN
  v_resolved := public.resolve_settings('saas_onboarding_policy', 'global', NULL);
  IF v_resolved IS NULL OR jsonb_typeof(v_resolved) <> 'object' THEN
    RETURN v_default;
  END IF;

  RETURN public.jsonb_deep_merge(v_default, v_resolved);
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_scope_settings_defaults_v1(
  p_scope_type TEXT,
  p_scope_id UUID,
  p_policy JSONB,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, FALSE);
  v_root TEXT := public.get_root_scope_type_key_v1();
  v_entity_table REGCLASS;
  v_category TEXT;
  v_source_row RECORD;
  v_schema_version INT;
  v_source_value JSONB;
  v_override_value JSONB;
  v_materialized_value JSONB;
  v_seeded JSONB := '[]'::jsonb;
  v_strict_required BOOLEAN := public.onboarding_policy_bool_v1(
    p_policy,
    ARRAY['materialize_defaults', v_scope_type, 'strict_required_coverage'],
    TRUE
  );
  v_missing_categories TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT r.entity_table
    INTO v_entity_table
    FROM public.scope_type_registry r
   WHERE r.scope_type = v_scope_type
     AND r.is_enabled = TRUE
   LIMIT 1;

  IF v_scope_type = v_root OR v_entity_table IS NULL THEN
    IF p_scope_id IS NOT NULL THEN
      RAISE EXCEPTION 'bootstrap_scope_settings_defaults_v1 scope_type=% requires NULL scope_id', v_scope_type;
    END IF;
  ELSE
    IF p_scope_id IS NULL THEN
      RAISE EXCEPTION 'bootstrap_scope_settings_defaults_v1 scope_type=% requires non-NULL scope_id', v_scope_type;
    END IF;
  END IF;

  FOR v_category IN
    SELECT c.category
    FROM public.onboarding_policy_categories_v1(p_policy, v_scope_type) AS c
  LOOP
    IF EXISTS (
      SELECT 1
      FROM public.settings s
      WHERE s.category = v_category
        AND s.scope_type = v_scope_type
        AND s.scope_id IS NOT DISTINCT FROM p_scope_id
    ) THEN
      CONTINUE;
    END IF;

    SELECT *
      INTO v_source_row
      FROM public.resolve_settings_row(v_category, v_scope_type, p_scope_id)
      LIMIT 1;

    IF v_source_row.settings_version_id IS NULL OR v_source_row.value IS NULL THEN
      CONTINUE;
    END IF;

    v_source_value := v_source_row.value;
    v_override_value := p_policy #> ARRAY[
      'materialize_defaults',
      v_scope_type,
      'category_value_overrides',
      v_category
    ];

    IF v_override_value IS NOT NULL AND jsonb_typeof(v_override_value) = 'object' THEN
      v_materialized_value := public.jsonb_deep_merge(v_source_value, v_override_value);
    ELSE
      v_materialized_value := v_source_value;
    END IF;

    SELECT COALESCE(sv.schema_version, sr.version, 1)
      INTO v_schema_version
      FROM public.settings_versions sv
      LEFT JOIN LATERAL (
        SELECT x.version
          FROM public.schema_registry x
         WHERE x.category = v_category
           AND x.is_active = TRUE
         ORDER BY x.version DESC
         LIMIT 1
      ) sr ON TRUE
     WHERE sv.id = v_source_row.settings_version_id
     LIMIT 1;

    PERFORM public.upsert_settings_value_v1(
      v_category,
      v_scope_type,
      p_scope_id,
      v_materialized_value,
      COALESCE(v_schema_version, 1),
      format('Onboarding bootstrap (%s) for %s/%s', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual'), v_scope_type, COALESCE(p_scope_id::text, 'null'))
    );

    v_seeded := v_seeded || jsonb_build_array(v_category);
  END LOOP;

  IF v_strict_required THEN
    SELECT COALESCE(array_agg(c.category ORDER BY c.category), ARRAY[]::TEXT[])
      INTO v_missing_categories
      FROM public.onboarding_policy_categories_v1(p_policy, v_scope_type) AS c
     WHERE NOT EXISTS (
       SELECT 1
       FROM public.settings s
       WHERE s.category = c.category
         AND s.scope_type = v_scope_type
         AND s.scope_id IS NOT DISTINCT FROM p_scope_id
     );

    IF array_length(v_missing_categories, 1) IS NOT NULL THEN
      RAISE EXCEPTION
        'bootstrap_scope_settings_defaults_v1 missing required defaults for %/%: %',
        v_scope_type,
        COALESCE(p_scope_id::TEXT, 'null'),
        array_to_string(v_missing_categories, ',');
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'seeded_categories', v_seeded,
    'strict_required_coverage', v_strict_required
  );
END;
$function$;

DO $$
DECLARE
  v_root_scope_type TEXT := public.get_root_scope_type_key_v1();
  v_current JSONB := COALESCE(
    public.resolve_settings('saas_onboarding_policy', public.get_root_scope_type_key_v1(), NULL),
    '{}'::jsonb
  );
  v_patch JSONB := jsonb_build_object(
    'materialize_defaults', jsonb_build_object(
      'tenant', jsonb_build_object(
        'category_value_overrides', jsonb_build_object(
          'mobile_shell_policy', jsonb_build_object(
            'version', 1,
            'v2_enabled', FALSE
          )
        )
      )
    )
  );
BEGIN
  PERFORM public.upsert_settings_value_v1(
    'saas_onboarding_policy',
    v_root_scope_type,
    NULL,
    public.jsonb_deep_merge(v_current, v_patch),
    1,
    'reconcile saas_onboarding_policy Mobile V2 tenant shell defaults'
  );
END $$;

DO $$
DECLARE
  v_org RECORD;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
  v_override_value JSONB := v_policy #> '{materialize_defaults,tenant,category_value_overrides,mobile_shell_policy}';
BEGIN
  IF v_override_value IS NULL OR jsonb_typeof(v_override_value) <> 'object' THEN
    RAISE EXCEPTION 'Mobile V2 tenant shell policy override is missing from saas_onboarding_policy'
      USING ERRCODE = '23514';
  END IF;

  FOR v_org IN
    SELECT o.id
    FROM public.organizations o
    WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY o.id
  LOOP
    PERFORM 1
      FROM public.settings s
     WHERE s.category = 'mobile_shell_policy'
       AND s.scope_type = 'tenant'
       AND s.scope_id = v_org.id
     LIMIT 1;

    IF NOT FOUND THEN
      PERFORM public.bootstrap_scope_settings_defaults_v1(
        'tenant',
        v_org.id,
        v_policy,
        'console-v2:mobile-v2-shell-policy-defaults-backfill'
      );
    END IF;
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605300115_onboarding_mobile_v2_shell_policy_defaults_v1'));

COMMIT;
