-- Migration: Console V2 navigation discoverability for core operator surfaces
-- Purpose:
--   Dashboard, service offerings, and import jobs are operator workbenches,
--   not raw table pages. Keep the row-driven ui_navigation, RBAC lookup
--   registry, role templates, and access_control_policy aligned so read-only
--   operators can reach the relevant screens through normal Console V2 nav.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605051930_console_v2_navigation_discoverability_import_catalog_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $lookup_permissions$
DECLARE
  v_definition_id UUID;
BEGIN
  SELECT id
    INTO v_definition_id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1;

  IF v_definition_id IS NULL THEN
    RAISE EXCEPTION 'rbac_permission lookup definition missing';
  END IF;

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
    v_definition_id,
    src.value,
    src.label,
    src.description,
    src.sort_order,
    FALSE,
    'active',
    jsonb_build_object('resource', src.resource_key, 'action', src.action_key, 'source', 'console_v2_navigation_discoverability_import_catalog_v1')
  FROM (VALUES
    ('imports.read', 'Imports Read', 'Read import job lifecycle and mapping runs', 3000, 'imports', 'read'),
    ('imports.write', 'Imports Write', 'Submit and cancel import job lifecycle runs', 3010, 'imports', 'write'),
    ('service_offerings.read', 'Service Offerings Read', 'Read service catalog offerings and levels', 3020, 'service_offerings', 'read'),
    ('service_offerings.write', 'Service Offerings Write', 'Manage service catalog offerings through approved paths', 3030, 'service_offerings', 'write')
  ) AS src(value, label, description, sort_order, resource_key, action_key)
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = public.lookup_values.metadata || EXCLUDED.metadata,
         updated_at = now();
END;
$lookup_permissions$;

DO $role_permissions$
BEGIN
  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value IN (
         'imports.read',
         'imports.write',
         'service_offerings.read',
         'service_offerings.write'
       )
  ),
  template_map AS (
    SELECT *
      FROM (VALUES
        ('ops_admin', 'imports.read'),
        ('ops_admin', 'imports.write'),
        ('ops_admin', 'service_offerings.read'),
        ('ops_admin', 'service_offerings.write'),
        ('agreements_admin', 'service_offerings.read'),
        ('agreements_admin', 'service_offerings.write')
      ) AS v(template_key, permission_value)
  )
  INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
  SELECT
    t.id,
    p.id,
    jsonb_build_object('seed', TRUE, 'template_key', t.key, 'source', 'console_v2_navigation_discoverability_import_catalog_v1')
  FROM template_map m
  JOIN public.rbac_role_templates t ON t.key = m.template_key
  JOIN permission_registry p ON p.value = m.permission_value
  ON CONFLICT (role_template_id, permission_id) DO NOTHING;

  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value IN (
         'imports.read',
         'imports.write',
         'service_offerings.read',
         'service_offerings.write'
       )
  ),
  role_map AS (
    SELECT *
      FROM (VALUES
        ('ops_admin', 'imports.read'),
        ('ops_admin', 'imports.write'),
        ('ops_admin', 'service_offerings.read'),
        ('ops_admin', 'service_offerings.write'),
        ('agreements_admin', 'service_offerings.read'),
        ('agreements_admin', 'service_offerings.write'),
        ('account_manager', 'service_offerings.read'),
        ('account_manager', 'service_offerings.write')
      ) AS v(role_key, permission_value)
  )
  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  SELECT
    r.organization_id,
    r.id,
    p.id,
    jsonb_build_object('source', 'console_v2_navigation_discoverability_import_catalog_v1')
  FROM role_map m
  JOIN public.rbac_roles r ON r.key = m.role_key
  JOIN permission_registry p ON p.value = m.permission_value
  ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING;
END;
$role_permissions$;

DO $access_policy$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_next_roles JSONB;
  v_role JSONB;
  v_role_caps JSONB;
  v_cap TEXT;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_next := v_current;
    v_caps := COALESCE(v_next->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    FOR v_cap IN SELECT * FROM unnest(ARRAY[
      'imports.read',
      'imports.write',
      'service_offerings.read',
      'service_offerings.write'
    ]::TEXT[])
    LOOP
      IF NOT EXISTS (
        SELECT 1
          FROM jsonb_array_elements(v_caps) AS item(value)
         WHERE item.value->>'key' = v_cap
      ) THEN
        v_caps := v_caps || jsonb_build_array(jsonb_build_object(
          'key', v_cap,
          'label', initcap(replace(v_cap, '.', ' '))
        ));
      END IF;
    END LOOP;

    v_next := jsonb_set(v_next, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(
      v_next,
      '{resource_map,imports}',
      public.deep_merge_jsonb(
        COALESCE(v_next#>'{resource_map,imports}', '{}'::jsonb),
        jsonb_build_object('read', 'imports.read', 'write', 'imports.write')
      ),
      TRUE
    );
    v_next := jsonb_set(
      v_next,
      '{resource_map,service_offerings}',
      public.deep_merge_jsonb(
        COALESCE(v_next#>'{resource_map,service_offerings}', '{}'::jsonb),
        jsonb_build_object('read', 'service_offerings.read', 'write', 'service_offerings.write')
      ),
      TRUE
    );

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    v_next_roles := '[]'::jsonb;
    FOR v_role IN SELECT value FROM jsonb_array_elements(v_roles) AS value
    LOOP
      v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
        v_role_caps := '[]'::jsonb;
      END IF;

      IF v_role->>'key' IN ('ops_admin', 'super_admin') THEN
        FOR v_cap IN SELECT * FROM unnest(ARRAY[
          'imports.read',
          'imports.write',
          'service_offerings.read',
          'service_offerings.write'
        ]::TEXT[])
        LOOP
          IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(v_role_caps) AS cap(value)
             WHERE cap.value = '*' OR cap.value = v_cap
          ) THEN
            v_role_caps := v_role_caps || jsonb_build_array(v_cap);
          END IF;
        END LOOP;
      ELSIF v_role->>'key' IN ('agreements_admin', 'account_manager') THEN
        FOR v_cap IN SELECT * FROM unnest(ARRAY[
          'service_offerings.read',
          'service_offerings.write'
        ]::TEXT[])
        LOOP
          IF NOT EXISTS (
            SELECT 1
              FROM jsonb_array_elements_text(v_role_caps) AS cap(value)
             WHERE cap.value = '*' OR cap.value = v_cap
          ) THEN
            v_role_caps := v_role_caps || jsonb_build_array(v_cap);
          END IF;
        END LOOP;
      END IF;

      v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      v_next_roles := v_next_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := jsonb_set(v_next, '{roles}', v_next_roles, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Expose Console V2 import jobs and service offerings through read navigation.',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$access_policy$;

DO $navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_sections JSONB;
  v_updated_sections JSONB;
  v_section JSONB;
  v_items JSONB;
  v_section_id TEXT;
  v_has_home BOOLEAN := FALSE;
  v_has_catalog BOOLEAN := FALSE;
  v_has_platform BOOLEAN := FALSE;
  v_dashboard_item JSONB := jsonb_build_object(
    'id', 'dashboard',
    'key', 'dashboard',
    'label', 'Dashboard',
    'href', '/',
    'route', '/',
    'resource', 'dashboard',
    'capability', NULL,
    'icon', 'dashboard'
  );
  v_service_item JSONB := jsonb_build_object(
    'id', 'catalog-service-offerings',
    'key', 'service-offerings',
    'label', 'Service offerings',
    'href', '/catalog/service-offerings',
    'route', '/catalog/service-offerings',
    'resource', 'service_offering_directory',
    'capability', 'service_offerings.read',
    'icon', 'tag'
  );
  v_import_item JSONB := jsonb_build_object(
    'id', 'platform-imports',
    'key', 'imports',
    'label', 'Import jobs',
    'href', '/platform/imports',
    'route', '/platform/imports',
    'resource', 'import_jobs',
    'capability', 'imports.read',
    'icon', 'inbox'
  );
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_navigation'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_sections := COALESCE(v_current#>'{apps,console,sections}', '[]'::jsonb);
    IF jsonb_typeof(v_sections) IS DISTINCT FROM 'array' THEN
      v_sections := '[]'::jsonb;
    END IF;

    v_updated_sections := '[]'::jsonb;
    v_has_home := FALSE;
    v_has_catalog := FALSE;
    v_has_platform := FALSE;

    FOR v_section IN SELECT value FROM jsonb_array_elements(v_sections) AS value
    LOOP
      v_section_id := lower(COALESCE(v_section->>'id', ''));
      v_items := COALESCE(v_section->'items', '[]'::jsonb);
      IF jsonb_typeof(v_items) IS DISTINCT FROM 'array' THEN
        v_items := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(item.value ORDER BY item.ordinality), '[]'::jsonb)
        INTO v_items
        FROM jsonb_array_elements(v_items) WITH ORDINALITY AS item(value, ordinality)
       WHERE COALESCE(item.value->>'route', item.value->>'href', '') NOT IN (
               '/',
               '/catalog/service-offerings',
               '/platform/imports'
             )
         AND COALESCE(item.value->>'key', item.value->>'id', '') NOT IN (
               'dashboard',
               'catalog-service-offerings',
               'service-offerings',
               'platform-imports',
               'imports'
             );

      IF v_section_id IN ('home', 'today') THEN
        v_items := jsonb_build_array(v_dashboard_item) || v_items;
        v_has_home := TRUE;
      ELSIF v_section_id IN ('catalog', 'reference-data', 'reference_data') THEN
        v_items := v_items || jsonb_build_array(v_service_item);
        v_has_catalog := TRUE;
      ELSIF v_section_id = 'platform' THEN
        v_items := v_items || jsonb_build_array(v_import_item);
        v_has_platform := TRUE;
      END IF;

      v_section := jsonb_set(v_section, '{items}', v_items, TRUE);
      v_updated_sections := v_updated_sections || jsonb_build_array(v_section);
    END LOOP;

    IF NOT v_has_home THEN
      v_updated_sections := jsonb_build_array(jsonb_build_object(
        'id', 'home',
        'label', 'Home',
        'items', jsonb_build_array(v_dashboard_item)
      )) || v_updated_sections;
    END IF;

    IF NOT v_has_catalog THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(jsonb_build_object(
        'id', 'catalog',
        'label', 'Catalog',
        'items', jsonb_build_array(v_service_item)
      ));
    END IF;

    IF NOT v_has_platform THEN
      v_updated_sections := v_updated_sections || jsonb_build_array(jsonb_build_object(
        'id', 'platform',
        'label', 'Platform',
        'items', jsonb_build_array(v_import_item)
      ));
    END IF;

    v_next := jsonb_set(v_current, '{apps,console,sections}', v_updated_sections, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Repair Console V2 dashboard, service offering, and import job navigation.',
             approved_at = now(),
             effective_from = now(),
             updated_at = now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;
END;
$navigation$;

SELECT pg_advisory_unlock(hashtext('202605051930_console_v2_navigation_discoverability_import_catalog_v1'));

COMMIT;
