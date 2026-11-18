-- Console V2 Platform/RBAC/Observability readiness repair.
-- Decision Log, resolution log, UI events, domain events, and trace surfaces
-- are intentionally gated by observability.read. Keep the live access policy,
-- RBAC permission registry, role templates, and already-provisioned ops_admin
-- roles aligned with that Console V2 gate.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606101100_console_v2_ops_admin_observability_readiness_v1'));
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
  VALUES (
    v_definition_id,
    'observability.read',
    'Observability Read',
    'Read Console V2 decision log, resolution log, domain events, UI events, and trace surfaces.',
    3650,
    FALSE,
    'active',
    jsonb_build_object(
      'resource', 'observability',
      'action', 'read',
      'source', 'console_v2_ops_admin_observability_readiness_v1'
    )
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
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
       AND lv.value = 'observability.read'
  ),
  template_map AS (
    SELECT 'ops_admin'::TEXT AS template_key, 'observability.read'::TEXT AS permission_value
  )
  INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
  SELECT
    t.id,
    p.id,
    jsonb_build_object(
      'seed', TRUE,
      'template_key', t.key,
      'source', 'console_v2_ops_admin_observability_readiness_v1'
    )
  FROM template_map m
  JOIN public.rbac_role_templates t ON t.key = m.template_key
  JOIN permission_registry p ON p.value = m.permission_value
  ON CONFLICT (role_template_id, permission_id) DO NOTHING;

  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value = 'observability.read'
  ),
  role_map AS (
    SELECT 'ops_admin'::TEXT AS role_key, 'observability.read'::TEXT AS permission_value
  )
  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  SELECT
    r.organization_id,
    r.id,
    p.id,
    jsonb_build_object('source', 'console_v2_ops_admin_observability_readiness_v1')
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
  v_changed BOOLEAN;
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
    v_changed := FALSE;

    v_caps := COALESCE(v_next->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) AS cap(value)
       WHERE cap.value->>'key' = 'observability.read'
    ) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', 'observability.read',
        'label', 'Observability Read',
        'category', 'observability'
      ));
      v_changed := TRUE;
    END IF;

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

      IF v_role->>'key' = 'ops_admin'
         AND NOT EXISTS (
           SELECT 1
             FROM jsonb_array_elements_text(v_role_caps) AS cap(value)
            WHERE cap.value IN ('*', 'observability.read')
         ) THEN
        v_role_caps := v_role_caps || jsonb_build_array('observability.read');
        v_changed := TRUE;
      END IF;

      v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      v_next_roles := v_next_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := jsonb_set(v_next, '{capabilities}', v_caps, TRUE);
    v_next := jsonb_set(v_next, '{roles}', v_next_roles, TRUE);

    IF v_changed AND v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Console V2: grant ops_admin observability.read for Decision Log readiness',
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

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$access_policy$;

DO $ui_read_registry$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_resources JSONB;
  v_next_resources JSONB;
  v_resource JSONB;
  v_directory_resource JSONB := jsonb_build_object(
    'key', 'decision_log_directory',
    'label', 'Decision log directory',
    'relation', 'public.v_decision_log_directory',
    'id_column', 'id',
    'capability_read', 'observability.read',
    'default_sort', jsonb_build_object('column', 'timestamp', 'direction', 'desc'),
    'scope_columns', jsonb_build_object('tenant', 'organization_id'),
    'columns', jsonb_build_array(
      jsonb_build_object('key', 'timestamp', 'label', 'When', 'format', 'datetime', 'sortable', TRUE),
      jsonb_build_object('key', 'decision_category', 'label', 'Category', 'sortable', TRUE, 'filterable', TRUE, 'lookup', 'decision_category'),
      jsonb_build_object('key', 'resource_type', 'label', 'Resource', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'resource_id', 'label', 'Resource ID', 'mono', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'resolved_from', 'label', 'Scope', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'scope_category', 'label', 'Scope category', 'mono', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'has_correlation', 'label', 'Has trace', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'has_resolution', 'label', 'Has resolution', 'sortable', TRUE, 'filterable', TRUE),
      jsonb_build_object('key', 'settings_resolution_id', 'label', 'Resolution', 'mono', TRUE)
    )
  );
  v_has_directory BOOLEAN;
  v_changed BOOLEAN;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'ui_read_registry'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    v_resources := COALESCE(v_current->'resources', '[]'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object'
       OR jsonb_typeof(v_resources) IS DISTINCT FROM 'array' THEN
      CONTINUE;
    END IF;

    v_next_resources := '[]'::jsonb;
    v_has_directory := FALSE;
    v_changed := FALSE;

    FOR v_resource IN SELECT value FROM jsonb_array_elements(v_resources) AS value
    LOOP
      IF v_resource->>'key' = 'decision_log' THEN
        IF v_resource->>'capability_read' IS DISTINCT FROM 'observability.read' THEN
          v_resource := v_resource || jsonb_build_object('capability_read', 'observability.read');
          v_changed := TRUE;
        END IF;
      ELSIF v_resource->>'key' = 'decision_log_directory' THEN
        v_has_directory := TRUE;
        IF (v_directory_resource || v_resource || jsonb_build_object('capability_read', 'observability.read'))
           IS DISTINCT FROM v_resource THEN
          v_resource := v_directory_resource || v_resource || jsonb_build_object('capability_read', 'observability.read');
          v_changed := TRUE;
        END IF;
      END IF;

      v_next_resources := v_next_resources || jsonb_build_array(v_resource);
    END LOOP;

    IF NOT v_has_directory THEN
      v_next_resources := v_next_resources || jsonb_build_array(v_directory_resource);
      v_changed := TRUE;
    END IF;

    v_next := jsonb_set(v_current, '{resources}', v_next_resources, TRUE);

    IF v_changed AND v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Console V2: align Decision Log registry with observability.read',
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

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_read_registry:%';
END;
$ui_read_registry$;

DO $ui_navigation$
DECLARE
  v_row RECORD;
  v_current JSONB;
  v_next JSONB;
  v_apps JSONB;
  v_sections JSONB;
  v_items JSONB;
  v_app RECORD;
  v_section RECORD;
  v_item RECORD;
  v_changed BOOLEAN;
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

    v_apps := '{}'::jsonb;
    v_changed := FALSE;

    FOR v_app IN
      SELECT key, value
        FROM jsonb_each(COALESCE(v_current->'apps', '{}'::jsonb))
    LOOP
      v_sections := '[]'::jsonb;

      FOR v_section IN
        SELECT value, ordinality
          FROM jsonb_array_elements(COALESCE(v_app.value->'sections', '[]'::jsonb))
            WITH ORDINALITY AS section(value, ordinality)
         ORDER BY ordinality
      LOOP
        v_items := '[]'::jsonb;

        FOR v_item IN
          SELECT value, ordinality
            FROM jsonb_array_elements(COALESCE(v_section.value->'items', '[]'::jsonb))
              WITH ORDINALITY AS item(value, ordinality)
           ORDER BY ordinality
        LOOP
          IF v_app.key = 'console'
             AND (
               v_item.value->>'id' = 'decision-log'
               OR v_item.value->>'key' = 'decision-log'
               OR COALESCE(v_item.value->>'route', v_item.value->>'href') = '/console/resources/decision_log'
             ) THEN
            v_item.value := v_item.value || jsonb_build_object(
              'id', 'decision-log',
              'key', 'decision-log',
              'label', 'Decision log',
              'icon', 'trace',
              'route', '/insights/decisions',
              'href', '/insights/decisions',
              'capability', 'observability.read'
            );
            v_changed := TRUE;
          ELSIF v_app.key = 'console'
             AND (
               v_item.value->>'id' IN ('audit-log', 'console-audit-logs')
               OR v_item.value->>'key' IN ('audit-log', 'console-audit-logs')
               OR COALESCE(v_item.value->>'route', v_item.value->>'href') = '/console/security/audit-logs'
             ) THEN
            v_item.value := v_item.value || jsonb_build_object(
              'id', 'audit-log',
              'key', 'audit-log',
              'label', 'Audit log',
              'icon', 'shield',
              'route', '/insights/audit',
              'href', '/insights/audit',
              'capability', 'audit_log.read'
            );
            v_changed := TRUE;
          END IF;

          v_items := v_items || jsonb_build_array(v_item.value);
        END LOOP;

        v_sections := v_sections || jsonb_build_array(
          jsonb_set(v_section.value, '{items}', v_items, TRUE)
        );
      END LOOP;

      v_apps := v_apps || jsonb_build_object(
        v_app.key,
        jsonb_set(v_app.value, '{sections}', v_sections, TRUE)
      );
    END LOOP;

    v_next := jsonb_set(v_current, '{apps}', v_apps, TRUE);

    IF v_changed AND v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Console V2: align Decision Log and Audit Log navigation with Insights routes',
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

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'ui_navigation:%';
END;
$ui_navigation$;

SELECT pg_advisory_unlock(hashtext('202606101100_console_v2_ops_admin_observability_readiness_v1'));

COMMIT;
