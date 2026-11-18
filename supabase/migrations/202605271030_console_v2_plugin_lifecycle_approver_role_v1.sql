-- Migration: Console V2 Plugin lifecycle approver role materialization v1
-- Purpose:
--   Keep the lower-permission integration plugin lifecycle role durable across
--   access policy, user-type lookup, RBAC templates, onboarding provisioning,
--   and existing tenant materialization.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271030_console_v2_plugin_lifecycle_approver_role_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $lookup_seed$
DECLARE
  v_permission_definition_id UUID;
  v_user_type_definition_id UUID;
BEGIN
  SELECT id
    INTO v_permission_definition_id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1;

  IF v_permission_definition_id IS NULL THEN
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
    v_permission_definition_id,
    src.value,
    src.label,
    src.description,
    src.sort_order,
    FALSE,
    'active',
    jsonb_build_object(
      'resource', src.resource_key,
      'action', src.action_key,
      'source', 'console_v2_plugin_lifecycle_approver_role_v1'
    )
  FROM (VALUES
    ('integration_plugins.read', 'Integration Plugins Read', 'Read integration plugin catalog, versions, validation runs, approvals, and bindings.', 3900, 'integration_plugins', 'read'),
    ('integration_plugins.write', 'Integration Plugins Write', 'Create, edit, and submit integration plugin draft versions.', 3910, 'integration_plugins', 'write'),
    ('integration_plugins.test', 'Integration Plugins Test', 'Run integration plugin validation and test events.', 3920, 'integration_plugins', 'test'),
    ('integration_plugins.approve', 'Integration Plugins Approve', 'Approve or reject submitted integration plugin versions.', 3930, 'integration_plugins', 'approve'),
    ('integration_plugins.activate', 'Integration Plugins Activate', 'Activate integration plugin versions and toggle runtime bindings.', 3940, 'integration_plugins', 'activate'),
    ('console_metadata.read', 'Console Metadata Read', 'Read Console navigation, shell metadata, and operator-facing catalog metadata.', 3950, 'console_metadata', 'read')
  ) AS src(value, label, description, sort_order, resource_key, action_key)
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = now();

  SELECT id
    INTO v_user_type_definition_id
    FROM public.lookup_definitions
   WHERE category = 'user_type'
   LIMIT 1;

  IF v_user_type_definition_id IS NULL THEN
    RAISE EXCEPTION 'user_type lookup definition missing';
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
    v_user_type_definition_id,
    'tenant_integrations_approver',
    'Tenant Integrations Approver',
    'Lower-permission tenant operator allowed to test, approve, activate, and toggle integration plugins without draft authoring.',
    8700,
    FALSE,
    'active',
    jsonb_build_object('source', 'console_v2_plugin_lifecycle_approver_role_v1')
  )
  ON CONFLICT (lookup_definition_id, value) DO UPDATE
     SET label = EXCLUDED.label,
         description = EXCLUDED.description,
         status = 'active',
         metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
         updated_at = now();
END;
$lookup_seed$;

INSERT INTO public.rbac_role_templates (key, name, description, is_active, metadata)
VALUES (
  'tenant_integrations_approver',
  'Tenant Integrations Approver',
  'Test, approve, activate, and toggle integration plugins without draft authoring access.',
  TRUE,
  jsonb_build_object(
    'seed', TRUE,
    'tier', 'functional',
    'source', 'console_v2_plugin_lifecycle_approver_role_v1'
  )
)
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    is_active = TRUE,
    metadata = COALESCE(public.rbac_role_templates.metadata, '{}'::jsonb) || EXCLUDED.metadata,
    updated_at = now();

WITH permission_registry AS (
  SELECT lv.id, lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value IN (
       'console_metadata.read',
       'integration_plugins.read',
       'integration_plugins.test',
       'integration_plugins.approve',
       'integration_plugins.activate'
     )
),
template_perm_map AS (
  SELECT *
    FROM (VALUES
      ('tenant_integrations_approver', 'console_metadata.read'),
      ('tenant_integrations_approver', 'integration_plugins.read'),
      ('tenant_integrations_approver', 'integration_plugins.test'),
      ('tenant_integrations_approver', 'integration_plugins.approve'),
      ('tenant_integrations_approver', 'integration_plugins.activate')
    ) AS v(template_key, permission_value)
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'template_key', t.key,
    'source', 'console_v2_plugin_lifecycle_approver_role_v1'
  )
FROM template_perm_map m
JOIN public.rbac_role_templates t
  ON t.key = m.template_key
JOIN permission_registry p
  ON p.value = m.permission_value
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

WITH write_permission AS (
  SELECT lv.id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'integration_plugins.write'
)
DELETE FROM public.rbac_role_template_permissions tp
USING public.rbac_role_templates t, write_permission p
WHERE tp.role_template_id = t.id
  AND tp.permission_id = p.id
  AND t.key = 'tenant_integrations_approver';

DO $access_policy$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_roles JSONB := '[]'::jsonb;
  v_updated_roles JSONB := '[]'::jsonb;
  v_entry JSONB;
  v_keys JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);

  FOR v_entry IN SELECT * FROM jsonb_array_elements(v_roles)
  LOOP
    IF v_entry->>'key' = 'tenant_integrations_approver' THEN
      v_keys := COALESCE(v_entry->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_keys) <> 'array' THEN
        v_keys := '[]'::jsonb;
      END IF;

      SELECT COALESCE(jsonb_agg(value), '[]'::jsonb)
        INTO v_keys
        FROM jsonb_array_elements_text(v_keys) AS item(value)
       WHERE value <> 'integration_plugins.write';

      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value = 'console_metadata.read') THEN
        v_keys := v_keys || jsonb_build_array('console_metadata.read');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value = 'integration_plugins.read') THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.read');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value = 'integration_plugins.test') THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.test');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value = 'integration_plugins.approve') THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.approve');
      END IF;
      IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements_text(v_keys) value WHERE value = 'integration_plugins.activate') THEN
        v_keys := v_keys || jsonb_build_array('integration_plugins.activate');
      END IF;

      v_entry := jsonb_set(v_entry, '{label}', to_jsonb('Tenant Integrations Approver'::text), true);
      v_entry := jsonb_set(v_entry, '{capability_keys}', v_keys, true);
    END IF;

    v_updated_roles := v_updated_roles || jsonb_build_array(v_entry);
  END LOOP;

  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_updated_roles) item
     WHERE item->>'key' = 'tenant_integrations_approver'
  ) THEN
    v_updated_roles := v_updated_roles || jsonb_build_array(
      jsonb_build_object(
        'key', 'tenant_integrations_approver',
        'label', 'Tenant Integrations Approver',
        'capability_keys', jsonb_build_array(
          'console_metadata.read',
          'integration_plugins.read',
          'integration_plugins.test',
          'integration_plugins.approve',
          'integration_plugins.activate'
        )
      )
    );
  END IF;

  v_next := jsonb_set(v_current, '{roles}', v_updated_roles, true);

  WITH current AS (
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'access_control_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Materialize tenant integrations approver access-policy role',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.scope_hash, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.settings_version_id = applied.id
     AND s.scope_hash = applied.scope_hash;
END;
$access_policy$;

DO $onboarding_policy$
DECLARE
  v_current JSONB;
  v_next JSONB;
  v_template_keys JSONB;
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
     AND sv.scope_hash = s.scope_hash
   WHERE s.category = 'saas_onboarding_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'saas_onboarding_policy global settings missing';
  END IF;

  v_template_keys := COALESCE(v_current #> '{rbac,template_keys}', '[]'::jsonb);
  IF jsonb_typeof(v_template_keys) <> 'array' THEN
    v_template_keys := '[]'::jsonb;
  END IF;

  IF NOT (v_template_keys ? 'tenant_integrations_approver') THEN
    v_template_keys := v_template_keys || jsonb_build_array('tenant_integrations_approver');
  END IF;

  v_next := v_current;
  v_next := jsonb_set(v_next, '{rbac}', COALESCE(v_next->'rbac', '{}'::jsonb), true);
  v_next := jsonb_set(v_next, '{rbac,template_keys}', v_template_keys, true);

  WITH current AS (
    SELECT s.id AS settings_id,
           s.settings_version_id,
           sv.version,
           sv.value
      FROM public.settings s
      JOIN public.settings_versions sv
        ON sv.id = s.settings_version_id
       AND sv.scope_hash = s.scope_hash
     WHERE s.category = 'saas_onboarding_policy'
       AND s.scope_type = 'global'
       AND s.scope_id IS NULL
     LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
       SET value = v_next,
           version = current.version + 1,
           change_reason = 'Add tenant integrations approver to onboarding RBAC templates',
           approved_at = now(),
           effective_from = now()
      FROM current
     WHERE sv.id = current.settings_version_id
       AND v_next IS DISTINCT FROM current.value
    RETURNING sv.id, sv.scope_hash, sv.value
  )
  UPDATE public.settings s
     SET cached_value = applied.value,
         last_updated = now()
    FROM applied
   WHERE s.settings_version_id = applied.id
     AND s.scope_hash = applied.scope_hash;
END;
$onboarding_policy$;

DO $backfill_existing_tenants$
DECLARE
  v_org RECORD;
BEGIN
  FOR v_org IN
    SELECT o.id
      FROM public.organizations o
     WHERE COALESCE(o.slug, '') <> 'global-root'
  LOOP
    PERFORM public.provision_rbac_roles_from_templates_v1(
      v_org.id,
      ARRAY['tenant_integrations_approver']::TEXT[],
      NULL
    );
  END LOOP;
END;
$backfill_existing_tenants$;

WITH write_permission AS (
  SELECT lv.id
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value = 'integration_plugins.write'
)
DELETE FROM public.rbac_role_permissions rp
USING public.rbac_roles r, write_permission p
WHERE rp.role_id = r.id
  AND rp.permission_id = p.id
  AND r.key = 'tenant_integrations_approver';

CREATE OR REPLACE FUNCTION public.user_capability_eval_for_user_v1(
  p_target_user_id UUID,
  p_capability_key TEXT,
  p_scope_type TEXT DEFAULT NULL,
  p_scope_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_actor_id UUID;
  v_target RECORD;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_policy JSONB;
  v_row RECORD;
  v_allowed BOOLEAN := FALSE;
  v_reason TEXT := 'no_policy';
  v_roles TEXT[] := ARRAY[]::TEXT[];
  v_caps TEXT[] := ARRAY[]::TEXT[];
BEGIN
  SELECT auth.uid() INTO v_actor_id;
  IF v_actor_id IS NULL THEN
    RETURN jsonb_build_object(
      'allowed', false,
      'reason', 'unauthenticated',
      'capability_key', p_capability_key,
      'role_keys', ARRAY[]::TEXT[],
      'granted_capabilities', ARRAY[]::TEXT[]
    );
  END IF;

  IF p_target_user_id IS NULL THEN
    RAISE EXCEPTION 'user_capability_eval_for_user_v1 requires target_user_id'
      USING ERRCODE = '22023';
  END IF;

  IF p_capability_key IS NULL OR btrim(p_capability_key) = '' THEN
    RAISE EXCEPTION 'user_capability_eval_for_user_v1 requires capability_key'
      USING ERRCODE = '22023';
  END IF;

  SELECT u.id,
         u.organization_id,
         u.user_type,
         u.access_scope_type,
         u.access_scope_id
    INTO v_target
    FROM public.users u
   WHERE u.id = p_target_user_id;

  IF v_target.id IS NULL THEN
    RAISE EXCEPTION 'target user not found'
      USING ERRCODE = 'P0002';
  END IF;

  v_scope_type := lower(COALESCE(NULLIF(p_scope_type, ''), NULLIF(v_target.access_scope_type, ''), 'global'));
  IF v_scope_type = 'platform' THEN
    v_scope_type := 'global';
  ELSIF v_scope_type = 'organization' THEN
    v_scope_type := 'tenant';
  END IF;

  v_scope_id := p_scope_id;
  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
  ELSIF v_scope_id IS NULL AND v_scope_type = 'tenant' THEN
    v_scope_id := v_target.organization_id;
  ELSIF v_scope_id IS NULL AND v_scope_type = COALESCE(NULLIF(v_target.access_scope_type, ''), v_scope_type) THEN
    v_scope_id := v_target.access_scope_id;
  END IF;

  IF v_scope_type = 'tenant'
     AND v_scope_id IS NOT NULL
     AND v_target.organization_id IS DISTINCT FROM v_scope_id THEN
    RAISE EXCEPTION 'target user outside requested tenant scope'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('users.read', v_scope_type, v_scope_id);
  PERFORM public.assert_capability_v1('access_policy.read', v_scope_type, v_scope_id);

  SELECT * INTO v_row
    FROM public.resolve_access_control_policy_v1(v_scope_type, v_scope_id, FALSE)
    LIMIT 1;

  v_policy := v_row.policy;

  IF v_policy IS NOT NULL THEN
    SELECT allowed, reason, role_keys, capability_keys
      INTO v_allowed, v_reason, v_roles, v_caps
      FROM public.access_eval_capability_v1(
        v_policy,
        p_capability_key,
        v_scope_type,
        v_scope_id,
        p_target_user_id,
        v_target.user_type
      );
  END IF;

  RETURN jsonb_build_object(
    'allowed', COALESCE(v_allowed, FALSE),
    'reason', COALESCE(v_reason, 'unknown'),
    'capability_key', p_capability_key,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id,
    'target_user_id', p_target_user_id,
    'role_keys', COALESCE(v_roles, ARRAY[]::TEXT[]),
    'granted_capabilities', COALESCE(v_caps, ARRAY[]::TEXT[]),
    'policy_source', jsonb_strip_nulls(jsonb_build_object(
      'settings_id', v_row.settings_id,
      'settings_version_id', v_row.settings_version_id,
      'policy_scope_type', v_row.scope_type,
      'policy_scope_id', v_row.scope_id,
      'scope_path', v_row.scope_path
    ))
  );
END;
$function$;

COMMENT ON FUNCTION public.user_capability_eval_for_user_v1(UUID, TEXT, TEXT, UUID) IS
  'Tenant-admin target-user capability evaluator for Console V2 Users drawer. Caller must have users.read and access_policy.read at the evaluated scope.';

REVOKE ALL ON FUNCTION public.user_capability_eval_for_user_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_capability_eval_for_user_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.user_capability_eval_for_user_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::JSONB);
  v_target_user_id UUID;
  v_scope_id UUID;
BEGIN
  IF jsonb_typeof(v_args) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'user_capability_eval_for_user_v1 expects a jsonb object payload'
      USING ERRCODE = '22023';
  END IF;

  v_target_user_id := NULLIF(btrim(COALESCE(v_args->>'target_user_id', v_args->>'user_id', '')), '')::UUID;
  BEGIN
    v_scope_id := NULLIF(btrim(COALESCE(v_args->>'scope_id', '')), '')::UUID;
  EXCEPTION WHEN others THEN
    v_scope_id := NULL;
  END;

  RETURN jsonb_build_object(
    'ok', true,
    'eval', public.user_capability_eval_for_user_v1(
      v_target_user_id,
      NULLIF(btrim(COALESCE(v_args->>'capability_key', '')), ''),
      NULLIF(btrim(COALESCE(v_args->>'scope_type', '')), ''),
      v_scope_id
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.user_capability_eval_for_user_v1(JSONB) IS
  'JSONB envelope wrapper for Console V2 target-user capability evaluation.';

REVOKE ALL ON FUNCTION public.user_capability_eval_for_user_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.user_capability_eval_for_user_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.user_capability_eval_for_user_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE SQL
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.user_capability_eval_for_user_v1(p_args);
$function$;

COMMENT ON FUNCTION api.user_capability_eval_for_user_v1(JSONB) IS
  'API-schema wrapper exposing Console V2 target-user capability evaluation for the Users drawer.';

REVOKE ALL ON FUNCTION api.user_capability_eval_for_user_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION api.user_capability_eval_for_user_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605271030_console_v2_plugin_lifecycle_approver_role_v1'));
COMMIT;
