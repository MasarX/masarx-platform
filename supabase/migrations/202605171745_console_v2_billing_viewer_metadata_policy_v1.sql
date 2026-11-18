-- Console V2 Billing Viewer metadata policy.
--
-- Billing read-only operators need enough metadata to boot the Console shell,
-- but that must not imply Reference Data or Settings access. Keep the persona
-- row-driven through access_control_policy and keep page resources separately
-- capability-gated.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605171745_console_v2_billing_viewer_metadata_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH definition AS (
  SELECT id
  FROM public.lookup_definitions
  WHERE category = 'user_type'
  LIMIT 1
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  status,
  metadata
)
SELECT
  definition.id,
  'billing_viewer',
  'Billing Viewer',
  'Read-only finance operator for Billing invoices and subscriptions.',
  890,
  false,
  'active',
  jsonb_build_object('domain', 'Finance', 'persona', 'billing_readonly')
FROM definition
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label,
    description = EXCLUDED.description,
    sort_order = EXCLUDED.sort_order,
    status = 'active',
    metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

DO $do$
DECLARE
  v_setting RECORD;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_assignments JSONB;
  v_user_type_assignments JSONB;
  v_cap_key TEXT;
  v_new_version INT;
  v_new_version_id UUID;
  v_target_caps TEXT[] := ARRAY['billing.read', 'console_metadata.read'];
BEGIN
  FOR v_setting IN
    SELECT
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.version,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_next := COALESCE(v_setting.value, '{}'::jsonb);
    v_caps := COALESCE(v_next->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOREACH v_cap_key IN ARRAY v_target_caps LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_caps) AS cap
        WHERE cap->>'key' = v_cap_key
      ) THEN
        v_caps := v_caps || jsonb_build_array(jsonb_build_object(
          'key', v_cap_key,
          'label', initcap(replace(v_cap_key, '.', ' ')),
          'category', split_part(v_cap_key, '.', 1)
        ));
      END IF;
    END LOOP;

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    SELECT COALESCE(jsonb_agg(role_item), '[]'::jsonb)
    INTO v_roles
    FROM jsonb_array_elements(v_roles) AS role_item
    WHERE role_item->>'key' <> 'billing_viewer';

    v_roles := v_roles || jsonb_build_array(jsonb_build_object(
      'key', 'billing_viewer',
      'label', 'Billing Viewer',
      'capability_keys', to_jsonb(v_target_caps)
    ));

    v_assignments := COALESCE(v_next->'assignments', '{}'::jsonb);
    IF jsonb_typeof(v_assignments) IS DISTINCT FROM 'object' THEN
      v_assignments := '{}'::jsonb;
    END IF;

    v_user_type_assignments := COALESCE(v_assignments->'user_type', '{}'::jsonb);
    IF jsonb_typeof(v_user_type_assignments) IS DISTINCT FROM 'object' THEN
      v_user_type_assignments := '{}'::jsonb;
    END IF;

    v_user_type_assignments := jsonb_set(
      v_user_type_assignments,
      '{billing_viewer}',
      '["billing_viewer"]'::jsonb,
      true
    );
    v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, true);

    v_next := jsonb_set(v_next, '{capabilities}', v_caps, true);
    v_next := jsonb_set(v_next, '{roles}', v_roles, true);
    v_next := jsonb_set(v_next, '{assignments}', v_assignments, true);

    IF v_next IS DISTINCT FROM v_setting.value THEN
      SELECT COALESCE(MAX(version), 0) + 1
      INTO v_new_version
      FROM public.settings_versions
      WHERE category = 'access_control_policy'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;

      UPDATE public.settings_versions
      SET effective_until = CASE
            WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
            ELSE now()
          END
      WHERE category = 'access_control_policy'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id
        AND approved_at IS NOT NULL
        AND effective_until IS NULL;

      INSERT INTO public.settings_versions (
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at
      )
      VALUES (
        'access_control_policy',
        v_setting.scope_type,
        v_setting.scope_id,
        v_new_version,
        v_next,
        COALESCE(v_setting.schema_version, 1),
        'Console V2 Billing Viewer: narrow shell metadata plus billing read',
        now()
      )
      RETURNING id INTO v_new_version_id;

      UPDATE public.settings
      SET settings_version_id = v_new_version_id,
          cached_value = v_next,
          last_updated = now()
      WHERE category = 'access_control_policy'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_setting RECORD;
  v_next JSONB;
  v_resources JSONB;
  v_new_resources JSONB;
  v_new_version INT;
  v_new_version_id UUID;
BEGIN
  FOR v_setting IN
    SELECT
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.version,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_next := COALESCE(v_setting.value, '{}'::jsonb);
    v_resources := COALESCE(v_next->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      v_resources := '[]'::jsonb;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN resource_item->>'key' = 'settings_category_registry'
          THEN jsonb_set(resource_item, '{capability_read}', to_jsonb('console_metadata.read'::text), true)
          ELSE resource_item
        END
      ),
      '[]'::jsonb
    )
    INTO v_new_resources
    FROM jsonb_array_elements(v_resources) AS resource_item;

    v_next := jsonb_set(v_next, '{resources}', v_new_resources, true);

    IF v_next IS DISTINCT FROM v_setting.value THEN
      SELECT COALESCE(MAX(version), 0) + 1
      INTO v_new_version
      FROM public.settings_versions
      WHERE category = 'ui_read_registry'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;

      UPDATE public.settings_versions
      SET effective_until = CASE
            WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
            ELSE now()
          END
      WHERE category = 'ui_read_registry'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id
        AND approved_at IS NOT NULL
        AND effective_until IS NULL;

      INSERT INTO public.settings_versions (
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at
      )
      VALUES (
        'ui_read_registry',
        v_setting.scope_type,
        v_setting.scope_id,
        v_new_version,
        v_next,
        COALESCE(v_setting.schema_version, 1),
        'Console V2 metadata boot: settings_category_registry uses console_metadata.read',
        now()
      )
      RETURNING id INTO v_new_version_id;

      UPDATE public.settings
      SET settings_version_id = v_new_version_id,
          cached_value = v_next,
          last_updated = now()
      WHERE category = 'ui_read_registry'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;
    END IF;
  END LOOP;
END;
$do$;

DO $do$
DECLARE
  v_setting RECORD;
  v_next JSONB;
  v_sections JSONB;
  v_new_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_new_items JSONB;
  v_item JSONB;
  v_new_version INT;
  v_new_version_id UUID;
BEGIN
  FOR v_setting IN
    SELECT
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.version,
      sv.schema_version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_next := COALESCE(v_setting.value, '{}'::jsonb);
    v_sections := COALESCE(v_next#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_new_sections := '[]'::jsonb;
    FOR v_section IN SELECT * FROM jsonb_array_elements(v_sections) LOOP
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      v_new_items := '[]'::jsonb;
      FOR v_item IN SELECT * FROM jsonb_array_elements(v_items) LOOP
        IF v_item->>'href' IN ('/platform/planning-os', '/platform/commands')
           OR v_item->>'route' IN ('/platform/planning-os', '/platform/commands')
           OR v_item->>'id' IN ('platform-planning-os', 'platform-commands') THEN
          v_item := jsonb_set(v_item, '{capability}', to_jsonb('audit_log.read'::text), true);
        END IF;
        v_new_items := v_new_items || jsonb_build_array(v_item);
      END LOOP;

      v_new_sections := v_new_sections || jsonb_build_array(jsonb_set(v_section, '{items}', v_new_items, true));
    END LOOP;

    v_next := jsonb_set(v_next, '{apps,console,sections}', v_new_sections, true);

    IF v_next IS DISTINCT FROM v_setting.value THEN
      SELECT COALESCE(MAX(version), 0) + 1
      INTO v_new_version
      FROM public.settings_versions
      WHERE category = 'ui_navigation'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;

      UPDATE public.settings_versions
      SET effective_until = CASE
            WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
            ELSE now()
          END
      WHERE category = 'ui_navigation'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id
        AND approved_at IS NOT NULL
        AND effective_until IS NULL;

      INSERT INTO public.settings_versions (
        category,
        scope_type,
        scope_id,
        version,
        value,
        schema_version,
        change_reason,
        approved_at
      )
      VALUES (
        'ui_navigation',
        v_setting.scope_type,
        v_setting.scope_id,
        v_new_version,
        v_next,
        COALESCE(v_setting.schema_version, 1),
        'Console V2 navigation: gate Planning OS and Commands with audit_log.read',
        now()
      )
      RETURNING id INTO v_new_version_id;

      UPDATE public.settings
      SET settings_version_id = v_new_version_id,
          cached_value = v_next,
          last_updated = now()
      WHERE category = 'ui_navigation'
        AND scope_type = v_setting.scope_type
        AND scope_id IS NOT DISTINCT FROM v_setting.scope_id;
    END IF;
  END LOOP;
END;
$do$;

CREATE OR REPLACE FUNCTION public.list_lookup_values_catalog_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS TABLE (
  category TEXT,
  value TEXT,
  label TEXT,
  description TEXT,
  sort_order INT,
  is_default BOOLEAN,
  metadata JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_has_lookup_read BOOLEAN := FALSE;
  v_has_console_metadata BOOLEAN := FALSE;
BEGIN
  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  BEGIN
    v_has_console_metadata := public.user_has_capability_v1('console_metadata.read');
  EXCEPTION
    WHEN others THEN
      v_has_console_metadata := FALSE;
  END;

  IF NOT (v_has_lookup_read OR v_has_console_metadata) THEN
    RAISE EXCEPTION 'list_lookup_values_catalog_v1 requires lookup_values read or console_metadata.read capability'
      USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    ld.category,
    lv.value,
    lv.label,
    lv.description,
    lv.sort_order,
    lv.is_default,
    COALESCE(lv.metadata, '{}'::jsonb) AS metadata
  FROM public.lookup_definitions ld
  JOIN public.lookup_values lv
    ON lv.lookup_definition_id = ld.id
  WHERE (p_include_inactive IS TRUE OR lv.status = 'active')
    AND (p_include_inactive IS TRUE OR lv.effective_from IS NULL OR lv.effective_from <= now())
    AND (p_include_inactive IS TRUE OR lv.effective_until IS NULL OR lv.effective_until > now())
  ORDER BY ld.category, lv.sort_order NULLS LAST, lv.label, lv.value;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_catalog_v1(BOOLEAN) IS
  'Returns the category-aware active lookup catalog for Console V2 startup hydration. Capability gated by lookup_values.read for Reference Data or console_metadata.read for shell boot.';

CREATE OR REPLACE FUNCTION public.list_lookup_values_catalog_json_v1(
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_has_lookup_read BOOLEAN := FALSE;
  v_has_console_metadata BOOLEAN := FALSE;
  v_catalog JSONB := '{}'::jsonb;
BEGIN
  BEGIN
    v_has_lookup_read := public.user_has_resource_capability_v1('lookup_values', 'read');
  EXCEPTION
    WHEN others THEN
      v_has_lookup_read := FALSE;
  END;

  BEGIN
    v_has_console_metadata := public.user_has_capability_v1('console_metadata.read');
  EXCEPTION
    WHEN others THEN
      v_has_console_metadata := FALSE;
  END;

  IF NOT (v_has_lookup_read OR v_has_console_metadata) THEN
    RAISE EXCEPTION 'list_lookup_values_catalog_json_v1 requires lookup_values read or console_metadata.read capability'
      USING ERRCODE = '42501';
  END IF;

  SELECT COALESCE(jsonb_object_agg(category, rows ORDER BY category), '{}'::jsonb)
  INTO v_catalog
  FROM (
    SELECT
      category,
      jsonb_agg(
        jsonb_build_object(
          'category', category,
          'value', value,
          'label', label,
          'description', description,
          'sort_order', sort_order,
          'is_default', is_default,
          'metadata', metadata
        )
        ORDER BY sort_order NULLS LAST, label, value
      ) AS rows
    FROM (
      SELECT
        ld.category,
        lv.value,
        lv.label,
        lv.description,
        lv.sort_order,
        lv.is_default,
        COALESCE(lv.metadata, '{}'::jsonb) AS metadata
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv
        ON lv.lookup_definition_id = ld.id
      WHERE (p_include_inactive IS TRUE OR lv.status = 'active')
        AND (p_include_inactive IS TRUE OR lv.effective_from IS NULL OR lv.effective_from <= now())
        AND (p_include_inactive IS TRUE OR lv.effective_until IS NULL OR lv.effective_until > now())
    ) catalog_rows
    GROUP BY category
  ) grouped;

  RETURN v_catalog;
END;
$function$;

COMMENT ON FUNCTION public.list_lookup_values_catalog_json_v1(BOOLEAN) IS
  'Returns the complete category-keyed active lookup catalog for Console V2 startup hydration. Capability gated by lookup_values.read for Reference Data or console_metadata.read for shell boot.';

SELECT pg_advisory_unlock(hashtext('202605171745_console_v2_billing_viewer_metadata_policy_v1'));

COMMIT;
