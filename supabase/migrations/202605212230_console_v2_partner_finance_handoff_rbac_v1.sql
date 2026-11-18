-- Migration: Console V2 partner finance handoff RBAC repair
-- Purpose:
--   Partners is the operational entry point for partner-scoped finance closeout.
--   Keep the backend access policy, RBAC lookup registry, role templates, and
--   already-provisioned ops_admin roles aligned with the Console V2
--   marketplace.read gate used by Network Partners and Marketplace. This
--   slice intentionally does not grant marketplace.write; write-capable
--   Marketplace lifecycle proof remains a separate readiness phase.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605212230_console_v2_partner_finance_handoff_rbac_v1'));
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
    jsonb_build_object(
      'resource',
      src.resource_key,
      'action',
      src.action_key,
      'source',
      'console_v2_partner_finance_handoff_rbac_v1'
    )
  FROM (VALUES
    ('network.read', 'Network Read', 'Read network operational workbenches', 3500, 'network', 'read'),
    ('marketplace.read', 'Marketplace Read', 'Read partner marketplace and participant lifecycle', 3510, 'marketplace', 'read')
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
       AND lv.value IN ('network.read', 'marketplace.read')
  ),
  template_map AS (
    SELECT *
      FROM (VALUES
        ('ops_admin', 'network.read'),
        ('ops_admin', 'marketplace.read')
      ) AS v(template_key, permission_value)
  )
  INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
  SELECT
    t.id,
    p.id,
    jsonb_build_object('seed', TRUE, 'template_key', t.key, 'source', 'console_v2_partner_finance_handoff_rbac_v1')
  FROM template_map m
  JOIN public.rbac_role_templates t ON t.key = m.template_key
  JOIN permission_registry p ON p.value = m.permission_value
  ON CONFLICT (role_template_id, permission_id) DO NOTHING;

  WITH permission_registry AS (
    SELECT lv.id, lv.value
      FROM public.lookup_values lv
      JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
     WHERE ld.category = 'rbac_permission'
       AND lv.value IN ('network.read', 'marketplace.read')
  ),
  role_map AS (
    SELECT *
      FROM (VALUES
        ('ops_admin', 'network.read'),
        ('ops_admin', 'marketplace.read')
      ) AS v(role_key, permission_value)
  )
  INSERT INTO public.rbac_role_permissions (organization_id, role_id, permission_id, metadata)
  SELECT
    r.organization_id,
    r.id,
    p.id,
    jsonb_build_object('source', 'console_v2_partner_finance_handoff_rbac_v1')
  FROM role_map m
  JOIN public.rbac_roles r ON r.key = m.role_key
  JOIN permission_registry p ON p.value = m.permission_value
  ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING;
END;
$role_permissions$;

DO $access_policy$
DECLARE
  v_existing_active_id UUID;
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_cap TEXT;
  v_cap_keys TEXT[] := ARRAY[]::TEXT[];
  v_role_idx INTEGER;
  v_target_caps TEXT[] := ARRAY[
    'network.read',
    'marketplace.read'
  ];
  v_changed BOOLEAN := FALSE;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  SELECT id, value
    INTO v_existing_active_id, v_current
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'Active global access_control_policy settings version is missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;

  SELECT COALESCE(array_agg(cap->>'key'), ARRAY[]::TEXT[])
    INTO v_cap_keys
    FROM jsonb_array_elements(v_caps) AS cap;

  FOREACH v_cap IN ARRAY v_target_caps LOOP
    IF NOT (v_cap = ANY(v_cap_keys)) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_cap,
        'label', initcap(replace(replace(v_cap, '.', ' '), '_', ' ')),
        'category', split_part(v_cap, '.', 1)
      ));
      v_changed := TRUE;
    END IF;
  END LOOP;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
    v_roles := '[]'::jsonb;
  END IF;

  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
        v_role_keys := '[]'::jsonb;
      END IF;

      FOREACH v_cap IN ARRAY v_target_caps LOOP
        IF NOT (v_role_keys @> to_jsonb(v_cap)) AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_cap);
          v_changed := TRUE;
        END IF;
      END LOOP;

      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN;
  END IF;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  UPDATE public.settings_versions
     SET effective_until = CASE
           WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
           ELSE now()
         END
   WHERE id = v_existing_active_id;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  INSERT INTO public.settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at
  ) VALUES (
    'access_control_policy',
    'global',
    NULL::uuid,
    v_next_version,
    v_current,
    1,
    'Console V2 partner finance handoff: grant network and marketplace capabilities to ops_admin',
    now()
  )
  RETURNING id INTO v_new_settings_version_id;

  UPDATE public.settings
     SET settings_version_id = v_new_settings_version_id,
         cached_value = v_current,
         last_updated = now()
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$access_policy$;

SELECT pg_advisory_unlock(hashtext('202605212230_console_v2_partner_finance_handoff_rbac_v1'));

COMMIT;
