-- Migration: FieldOps Mobile V2 hold queue access
-- Date: 2026-05-29
-- Purpose:
--   Keep Mobile V2 Hold Queue discoverability row-driven. The navigation item
--   already exists and is gated by hold.read; first-tenant FieldOps runtime
--   roles need hold.read plus hold.write so operators can reach the queue and
--   submit backend-backed hold decisions from the visible V2 shell.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605292355_fieldops_mobile_v2_hold_queue_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'rbac_permission',
  'RBAC permissions registry (stable keys) for RLS/RPC predicates',
  'security',
  'tier_1',
  TRUE
)
ON CONFLICT (category) DO NOTHING;

WITH permission_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'rbac_permission'
   LIMIT 1
),
permission_rows AS (
  SELECT *
    FROM (VALUES
      ('hold.read', 'Hold Queue Read', 'Read FieldOps Mobile V2 hold queue items.', 9480, 'hold', 'read'),
      ('hold.write', 'Hold Queue Write', 'Submit FieldOps Mobile V2 hold queue decisions.', 9481, 'hold', 'write')
    ) AS v(value, label, description, sort_order, resource_key, action_key)
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
  pd.id,
  pr.value,
  pr.label,
  pr.description,
  pr.sort_order,
  FALSE,
  'active',
  jsonb_build_object(
    'resource', pr.resource_key,
    'action', pr.action_key,
    'source', 'fieldops_mobile_v2_hold_queue_access_v1'
  )
FROM permission_definition pd
CROSS JOIN permission_rows pr
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       status = 'active',
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       updated_at = now();

WITH permission_registry AS (
  SELECT lv.id, lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value IN ('hold.read', 'hold.write')
),
template_perm_map AS (
  SELECT *
    FROM (VALUES
      ('fieldops_money_driver', 'hold.read'),
      ('fieldops_money_driver', 'hold.write'),
      ('warehouse_operator', 'hold.read'),
      ('warehouse_operator', 'hold.write')
    ) AS v(template_key, permission_value)
)
INSERT INTO public.rbac_role_template_permissions (role_template_id, permission_id, metadata)
SELECT
  t.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'template_key', t.key,
    'source', 'fieldops_mobile_v2_hold_queue_access_v1'
  )
FROM template_perm_map m
JOIN public.rbac_role_templates t
  ON t.key = m.template_key
JOIN permission_registry p
  ON p.value = m.permission_value
ON CONFLICT (role_template_id, permission_id) DO NOTHING;

WITH permission_registry AS (
  SELECT lv.id, lv.value
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld
      ON ld.id = lv.lookup_definition_id
   WHERE ld.category = 'rbac_permission'
     AND lv.value IN ('hold.read', 'hold.write')
)
INSERT INTO public.rbac_role_permissions (
  organization_id,
  role_id,
  permission_id,
  metadata
)
SELECT
  r.organization_id,
  r.id,
  p.id,
  jsonb_build_object(
    'seed', TRUE,
    'role_key', r.key,
    'source', 'fieldops_mobile_v2_hold_queue_access_v1'
  )
FROM public.rbac_roles r
CROSS JOIN permission_registry p
WHERE r.key IN ('fieldops_money_driver', 'warehouse_operator')
ON CONFLICT ON CONSTRAINT rbac_role_permissions_unique DO NOTHING;

CREATE OR REPLACE FUNCTION pg_temp.fieldops_mobile_v2_hold_queue_policy_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_caps JSONB := COALESCE(p_policy->'capabilities', '[]'::jsonb);
  v_roles JSONB := COALESCE(p_policy->'roles', '[]'::jsonb);
  v_assignments JSONB := COALESCE(p_policy->'assignments', '{}'::jsonb);
  v_user_type_assignments JSONB := COALESCE(p_policy#>'{assignments,user_type}', '{}'::jsonb);
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_role_name TEXT;
  v_cap TEXT;
  v_found_role BOOLEAN;
  v_target_caps TEXT[] := ARRAY['hold.read', 'hold.write'];
BEGIN
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
    v_roles := '[]'::jsonb;
  END IF;
  IF jsonb_typeof(v_assignments) IS DISTINCT FROM 'object' THEN
    v_assignments := '{}'::jsonb;
  END IF;
  IF jsonb_typeof(v_user_type_assignments) IS DISTINCT FROM 'object' THEN
    v_user_type_assignments := '{}'::jsonb;
  END IF;

  FOREACH v_cap IN ARRAY v_target_caps LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) cap
       WHERE cap->>'key' = v_cap
    ) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_cap,
        'label', initcap(replace(v_cap, '.', ' ')),
        'category', 'operate'
      ));
    END IF;
  END LOOP;

  FOREACH v_role_name IN ARRAY ARRAY['fieldops_money_driver', 'warehouse_operator'] LOOP
    IF NOT (v_user_type_assignments ? v_role_name) THEN
      v_user_type_assignments := jsonb_set(
        v_user_type_assignments,
        ARRAY[v_role_name],
        jsonb_build_array(v_role_name),
        TRUE
      );
    END IF;

    v_found_role := FALSE;
    FOR v_role_idx IN 0 .. GREATEST(jsonb_array_length(v_roles) - 1, -1) LOOP
      v_role := v_roles->v_role_idx;
      IF v_role->>'key' = v_role_name THEN
        v_found_role := TRUE;
        v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
          v_role_keys := '[]'::jsonb;
        END IF;

        FOREACH v_cap IN ARRAY v_target_caps LOOP
          IF NOT (v_role_keys @> to_jsonb(v_cap))
             AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
            v_role_keys := v_role_keys || to_jsonb(v_cap);
          END IF;
        END LOOP;

        v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, TRUE);
        IF v_role_name = 'warehouse_operator' THEN
          v_role := jsonb_set(v_role, '{mobile_v2_role}', to_jsonb('loader'::text), TRUE);
        END IF;
        v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, TRUE);
      END IF;
    END LOOP;

    IF NOT v_found_role THEN
      v_roles := v_roles || jsonb_build_array(jsonb_build_object(
        'key', v_role_name,
        'label', CASE
          WHEN v_role_name = 'warehouse_operator' THEN 'Warehouse Operator'
          ELSE 'FieldOps Money Driver'
        END,
        'mobile_v2_role', CASE
          WHEN v_role_name = 'warehouse_operator' THEN 'loader'
          ELSE NULL
        END,
        'capability_keys', to_jsonb(v_target_caps)
      ));
    END IF;
  END LOOP;

  v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, TRUE);
  v_policy := jsonb_set(v_policy, '{capabilities}', v_caps, TRUE);
  v_policy := jsonb_set(v_policy, '{roles}', v_roles, TRUE);
  v_policy := jsonb_set(v_policy, '{assignments}', v_assignments, TRUE);
  RETURN v_policy;
END;
$$;

DO $do$
DECLARE
  v_rec RECORD;
  v_next JSONB;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  FOR v_rec IN
    SELECT id, category, scope_type, scope_id, value
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
     ORDER BY scope_type, scope_id NULLS FIRST, version
  LOOP
    v_next := pg_temp.fieldops_mobile_v2_hold_queue_policy_v1(v_rec.value);
    IF v_next IS NOT DISTINCT FROM v_rec.value THEN
      CONTINUE;
    END IF;

    UPDATE public.settings_versions
       SET effective_until = GREATEST(now(), effective_from + interval '1 millisecond')
     WHERE id = v_rec.id;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);

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
      v_rec.category,
      v_rec.scope_type,
      v_rec.scope_id,
      v_next_version,
      v_next,
      1,
      'FieldOps Mobile V2 hold queue: grant hold read/write access to runtime roles.',
      now()
    )
    RETURNING id INTO v_new_settings_version_id;

    UPDATE public.settings
       SET settings_version_id = v_new_settings_version_id,
           cached_value = v_next,
           last_updated = now()
     WHERE category = v_rec.category
       AND scope_type = v_rec.scope_type
       AND COALESCE(scope_id, '00000000-0000-0000-0000-000000000000'::uuid)
           = COALESCE(v_rec.scope_id, '00000000-0000-0000-0000-000000000000'::uuid);
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%'
      OR cache_key LIKE 'ui_navigation:%';
END;
$do$;

SELECT pg_notify('pgrst', 'reload schema');

SELECT pg_advisory_unlock(hashtext('202605292355_fieldops_mobile_v2_hold_queue_access_v1'));
COMMIT;
