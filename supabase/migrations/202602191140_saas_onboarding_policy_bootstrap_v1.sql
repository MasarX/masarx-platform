-- Migration: SaaS onboarding policy + automatic tenant/client/sender defaults bootstrap
BEGIN;
SELECT pg_advisory_lock(hashtext('202602191140_saas_onboarding_policy_bootstrap_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- 1) Register onboarding policy category (global-only, row-driven)
INSERT INTO public.settings_category_registry (
  category,
  description,
  requires_schema,
  requires_global_default,
  side_effecting,
  safe_missing_behavior,
  allowed_scopes
)
VALUES (
  'saas_onboarding_policy',
  'Policy-driven bootstrap for new tenant/client/sender entities (defaults materialization + RBAC templates).',
  TRUE,
  TRUE,
  TRUE,
  'skip',
  '["global"]'::jsonb
)
ON CONFLICT (category) DO UPDATE
SET
  description = EXCLUDED.description,
  requires_schema = EXCLUDED.requires_schema,
  requires_global_default = EXCLUDED.requires_global_default,
  side_effecting = EXCLUDED.side_effecting,
  safe_missing_behavior = EXCLUDED.safe_missing_behavior,
  allowed_scopes = EXCLUDED.allowed_scopes,
  updated_at = now();

-- 2) Schema contract + canonical default example
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'saas_onboarding_policy',
  1,
  jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'additionalProperties', TRUE,
    'required', jsonb_build_array('version', 'enabled', 'ensure_global_required_defaults', 'materialize_defaults', 'rbac', 'client_defaults'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean'),
      'ensure_global_required_defaults', jsonb_build_object('type', 'boolean'),
      'materialize_defaults', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'tenant', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'use_registry_required_defaults', jsonb_build_object('type', 'boolean'),
              'include_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
              'exclude_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
            )
          ),
          'client', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'use_registry_required_defaults', jsonb_build_object('type', 'boolean'),
              'include_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
              'exclude_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
            )
          ),
          'sender', jsonb_build_object(
            'type', 'object',
            'additionalProperties', TRUE,
            'properties', jsonb_build_object(
              'use_registry_required_defaults', jsonb_build_object('type', 'boolean'),
              'include_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string')),
              'exclude_categories', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
            )
          )
        )
      ),
      'rbac', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'provision_templates', jsonb_build_object('type', 'boolean'),
          'template_keys', jsonb_build_object('type', 'array', 'items', jsonb_build_object('type', 'string'))
        )
      ),
      'client_defaults', jsonb_build_object(
        'type', 'object',
        'additionalProperties', TRUE,
        'properties', jsonb_build_object(
          'create_default_sender', jsonb_build_object('type', 'boolean'),
          'default_sender_name', jsonb_build_object('type', 'string'),
          'default_sender_brand_name', jsonb_build_object('type', jsonb_build_array('string', 'null'))
        )
      )
    )
  ),
  'Policy controlling automatic onboarding bootstrap for new organizations/clients/senders.',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'ensure_global_required_defaults', TRUE,
      'materialize_defaults', jsonb_build_object(
        'tenant', jsonb_build_object(
          'use_registry_required_defaults', TRUE,
          'include_categories', jsonb_build_array(),
          'exclude_categories', jsonb_build_array('saas_onboarding_policy')
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
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET
  schema = EXCLUDED.schema,
  description = EXCLUDED.description,
  examples = EXCLUDED.examples,
  is_active = TRUE,
  deprecated_at = NULL;

-- 3) Seed global onboarding policy if missing
DO $$
DECLARE
  v_exists BOOLEAN;
  v_default JSONB := jsonb_build_object(
    'version', 1,
    'enabled', TRUE,
    'ensure_global_required_defaults', TRUE,
    'materialize_defaults', jsonb_build_object(
      'tenant', jsonb_build_object(
        'use_registry_required_defaults', TRUE,
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('saas_onboarding_policy')
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
BEGIN
  SELECT EXISTS (
    SELECT 1
      FROM public.settings s
     WHERE s.category = 'saas_onboarding_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
  )
  INTO v_exists;

  IF v_exists IS FALSE THEN
    PERFORM public.upsert_settings_value_v1(
      'saas_onboarding_policy',
      'global',
      NULL,
      v_default,
      1,
      'seed saas_onboarding_policy global defaults'
    );
  END IF;
END $$;

-- 4) Helpers and bootstrap functions
CREATE OR REPLACE FUNCTION public.onboarding_policy_bool_v1(
  p_policy JSONB,
  p_path TEXT[],
  p_default BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_text TEXT;
BEGIN
  v_text := p_policy #>> p_path;
  IF v_text IS NULL OR btrim(v_text) = '' THEN
    RETURN p_default;
  END IF;

  BEGIN
    RETURN v_text::BOOLEAN;
  EXCEPTION
    WHEN others THEN
      RETURN p_default;
  END;
END;
$function$;

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
        'include_categories', jsonb_build_array(),
        'exclude_categories', jsonb_build_array('saas_onboarding_policy')
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

CREATE OR REPLACE FUNCTION public.onboarding_policy_categories_v1(
  p_policy JSONB,
  p_scope_type TEXT
)
RETURNS TABLE (category TEXT)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_scope_type TEXT := public.normalize_scope_type_v1(p_scope_type, TRUE);
  v_categories TEXT[] := ARRAY[]::TEXT[];
  v_category TEXT;
  v_allowed_scopes JSONB;
  v_use_registry BOOLEAN := public.onboarding_policy_bool_v1(
    p_policy,
    ARRAY['materialize_defaults', v_scope_type, 'use_registry_required_defaults'],
    FALSE
  );
  v_include JSONB := COALESCE(p_policy #> ARRAY['materialize_defaults', v_scope_type, 'include_categories'], '[]'::jsonb);
  v_exclude JSONB := COALESCE(p_policy #> ARRAY['materialize_defaults', v_scope_type, 'exclude_categories'], '[]'::jsonb);
BEGIN
  IF v_use_registry THEN
    FOR v_category IN
      SELECT scr.category
      FROM public.settings_category_registry scr
      WHERE scr.requires_global_default = TRUE
        AND (
          scr.allowed_scopes IS NULL
          OR jsonb_typeof(scr.allowed_scopes) <> 'array'
          OR scr.allowed_scopes ? v_scope_type
        )
    LOOP
      IF v_category IS NULL OR btrim(v_category) = '' THEN
        CONTINUE;
      END IF;
      IF NOT (v_category = ANY(v_categories)) THEN
        v_categories := array_append(v_categories, v_category);
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(v_include) = 'array' THEN
    FOR v_category IN
      SELECT NULLIF(btrim(value), '')
      FROM jsonb_array_elements_text(v_include)
    LOOP
      IF v_category IS NULL THEN
        CONTINUE;
      END IF;

      SELECT scr.allowed_scopes
        INTO v_allowed_scopes
        FROM public.settings_category_registry scr
       WHERE scr.category = v_category
       LIMIT 1;

      IF v_allowed_scopes IS NOT NULL
         AND jsonb_typeof(v_allowed_scopes) = 'array'
         AND NOT (v_allowed_scopes ? v_scope_type) THEN
        CONTINUE;
      END IF;

      IF NOT (v_category = ANY(v_categories)) THEN
        v_categories := array_append(v_categories, v_category);
      END IF;
    END LOOP;
  END IF;

  IF jsonb_typeof(v_exclude) = 'array' THEN
    FOR v_category IN
      SELECT NULLIF(btrim(value), '')
      FROM jsonb_array_elements_text(v_exclude)
    LOOP
      IF v_category IS NULL THEN
        CONTINUE;
      END IF;
      v_categories := array_remove(v_categories, v_category);
    END LOOP;
  END IF;

  RETURN QUERY
  SELECT c
  FROM unnest(v_categories) AS c
  ORDER BY c;
END;
$function$;

CREATE OR REPLACE FUNCTION public.ensure_required_global_defaults_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT;
  v_schema_version INT;
  v_example JSONB;
  v_seeded JSONB := '[]'::jsonb;
  v_skipped JSONB := '[]'::jsonb;
BEGIN
  FOR v_category IN
    SELECT scr.category
    FROM public.settings_category_registry scr
    WHERE scr.requires_global_default = TRUE
    ORDER BY scr.category
  LOOP
    IF EXISTS (
      SELECT 1
        FROM public.settings s
       WHERE s.category = v_category
         AND s.scope_type = 'global'
         AND s.scope_id IS NULL
    ) THEN
      CONTINUE;
    END IF;

    SELECT sr.version, sr.examples->0
      INTO v_schema_version, v_example
      FROM public.schema_registry sr
     WHERE sr.category = v_category
       AND sr.is_active = TRUE
     ORDER BY sr.version DESC
     LIMIT 1;

    IF v_example IS NULL THEN
      v_skipped := v_skipped || jsonb_build_array(
        jsonb_build_object('category', v_category, 'reason', 'missing_schema_example')
      );
      CONTINUE;
    END IF;

    BEGIN
      PERFORM public.upsert_settings_value_v1(
        v_category,
        'global',
        NULL,
        v_example,
        COALESCE(v_schema_version, 1),
        format('Auto-seed missing global default during onboarding (%s)', v_category)
      );
      v_seeded := v_seeded || jsonb_build_array(v_category);
    EXCEPTION
      WHEN others THEN
        v_skipped := v_skipped || jsonb_build_array(
          jsonb_build_object('category', v_category, 'reason', SQLERRM)
        );
    END;
  END LOOP;

  RETURN jsonb_build_object(
    'seeded_categories', v_seeded,
    'skipped_categories', v_skipped
  );
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
  v_seeded JSONB := '[]'::jsonb;
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
      v_source_row.value,
      COALESCE(v_schema_version, 1),
      format('Onboarding bootstrap (%s) for %s/%s', COALESCE(NULLIF(btrim(p_trigger_source), ''), 'manual'), v_scope_type, COALESCE(p_scope_id::text, 'null'))
    );

    v_seeded := v_seeded || jsonb_build_array(v_category);
  END LOOP;

  RETURN jsonb_build_object(
    'scope_type', v_scope_type,
    'scope_id', p_scope_id,
    'seeded_categories', v_seeded
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_tenant_onboarding_v1(
  p_organization_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_ensure_globals BOOLEAN;
  v_provision_templates BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_globals_result JSONB := '{}'::jsonb;
  v_template_keys_json JSONB;
  v_template_keys TEXT[] := ARRAY[]::TEXT[];
  v_template TEXT;
  v_provisioned JSONB := '[]'::jsonb;
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.organizations o WHERE o.id = p_organization_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_tenant_onboarding_v1: organization % not found', p_organization_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'organization_id', p_organization_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_ensure_globals := public.onboarding_policy_bool_v1(v_policy, ARRAY['ensure_global_required_defaults'], TRUE);
  IF v_ensure_globals THEN
    v_globals_result := public.ensure_required_global_defaults_v1();
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('tenant', p_organization_id, v_policy, p_trigger_source);

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
        p_organization_id,
        v_template_keys,
        NULL
      );

      FOREACH v_template IN ARRAY v_template_keys LOOP
        v_provisioned := v_provisioned || jsonb_build_array(v_template);
      END LOOP;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'organization_id', p_organization_id,
    'scope_defaults', v_scope_result,
    'global_defaults', v_globals_result,
    'rbac_templates_provisioned', v_provisioned
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_client_onboarding_v1(
  p_client_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
  v_create_default_sender BOOLEAN;
  v_default_sender_name TEXT;
  v_default_sender_brand_name TEXT;
  v_default_sender_created BOOLEAN := FALSE;
BEGIN
  IF p_client_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.clients c WHERE c.id = p_client_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_client_onboarding_v1: client % not found', p_client_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'client_id', p_client_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('client', p_client_id, v_policy, p_trigger_source);

  v_create_default_sender := public.onboarding_policy_bool_v1(
    v_policy,
    ARRAY['client_defaults', 'create_default_sender'],
    TRUE
  );

  IF v_create_default_sender THEN
    v_default_sender_name := NULLIF(btrim(COALESCE(v_policy #>> ARRAY['client_defaults', 'default_sender_name'], 'Default Sender')), '');
    IF v_default_sender_name IS NULL THEN
      v_default_sender_name := 'Default Sender';
    END IF;

    v_default_sender_brand_name := NULLIF(btrim(v_policy #>> ARRAY['client_defaults', 'default_sender_brand_name']), '');

    IF NOT EXISTS (
      SELECT 1
      FROM public.senders s
      WHERE s.client_id = p_client_id
    ) THEN
      INSERT INTO public.senders (
        client_id,
        name,
        brand_name,
        auto_provisioned,
        auto_recreate,
        status
      ) VALUES (
        p_client_id,
        v_default_sender_name,
        v_default_sender_brand_name,
        FALSE,
        TRUE,
        'active'
      );

      v_default_sender_created := TRUE;
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'client_id', p_client_id,
    'scope_defaults', v_scope_result,
    'default_sender_created', v_default_sender_created
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.bootstrap_sender_onboarding_v1(
  p_sender_id UUID,
  p_trigger_source TEXT DEFAULT 'manual'
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_scope_result JSONB := '{}'::jsonb;
BEGIN
  IF p_sender_id IS NULL THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender_id is required' USING ERRCODE = '23502';
  END IF;

  PERFORM 1 FROM public.senders s WHERE s.id = p_sender_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'bootstrap_sender_onboarding_v1: sender % not found', p_sender_id USING ERRCODE = '23503';
  END IF;

  v_policy := public.resolve_saas_onboarding_policy_v1();
  v_enabled := public.onboarding_policy_bool_v1(v_policy, ARRAY['enabled'], TRUE);
  IF v_enabled IS FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'enabled', FALSE,
      'sender_id', p_sender_id,
      'reason', 'disabled_by_policy'
    );
  END IF;

  v_scope_result := public.bootstrap_scope_settings_defaults_v1('sender', p_sender_id, v_policy, p_trigger_source);

  RETURN jsonb_build_object(
    'ok', TRUE,
    'enabled', TRUE,
    'sender_id', p_sender_id,
    'scope_defaults', v_scope_result
  );
END;
$function$;

-- Trigger wrappers (fail-closed by default; bootstrap errors stop insert)
CREATE OR REPLACE FUNCTION public.trigger_bootstrap_tenant_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.bootstrap_tenant_onboarding_v1(NEW.id, 'trigger:organizations.insert');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_bootstrap_client_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.bootstrap_client_onboarding_v1(NEW.id, 'trigger:clients.insert');
  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.trigger_bootstrap_sender_onboarding_v1()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  PERFORM public.bootstrap_sender_onboarding_v1(NEW.id, 'trigger:senders.insert');
  RETURN NEW;
END;
$function$;

-- 5) Least-privilege grants
REVOKE ALL ON FUNCTION public.onboarding_policy_bool_v1(JSONB, TEXT[], BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.resolve_saas_onboarding_policy_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.onboarding_policy_categories_v1(JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ensure_required_global_defaults_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_scope_settings_defaults_v1(TEXT, UUID, JSONB, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_tenant_onboarding_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_client_onboarding_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bootstrap_sender_onboarding_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_bootstrap_tenant_onboarding_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_bootstrap_client_onboarding_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.trigger_bootstrap_sender_onboarding_v1() FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.resolve_saas_onboarding_policy_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.ensure_required_global_defaults_v1() TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_tenant_onboarding_v1(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_client_onboarding_v1(UUID, TEXT) TO service_role;
GRANT EXECUTE ON FUNCTION public.bootstrap_sender_onboarding_v1(UUID, TEXT) TO service_role;

-- 6) Attach triggers
DROP TRIGGER IF EXISTS trg_organizations_bootstrap_onboarding_v1 ON public.organizations;
CREATE TRIGGER trg_organizations_bootstrap_onboarding_v1
  AFTER INSERT ON public.organizations
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_bootstrap_tenant_onboarding_v1();

DROP TRIGGER IF EXISTS trg_clients_bootstrap_onboarding_v1 ON public.clients;
CREATE TRIGGER trg_clients_bootstrap_onboarding_v1
  AFTER INSERT ON public.clients
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_bootstrap_client_onboarding_v1();

DROP TRIGGER IF EXISTS trg_senders_bootstrap_onboarding_v1 ON public.senders;
CREATE TRIGGER trg_senders_bootstrap_onboarding_v1
  AFTER INSERT ON public.senders
  FOR EACH ROW
  EXECUTE FUNCTION public.trigger_bootstrap_sender_onboarding_v1();

-- 7) One-time reconciliation for required global defaults (idempotent)
SELECT public.ensure_required_global_defaults_v1();

SELECT pg_advisory_unlock(hashtext('202602191140_saas_onboarding_policy_bootstrap_v1'));
COMMIT;
