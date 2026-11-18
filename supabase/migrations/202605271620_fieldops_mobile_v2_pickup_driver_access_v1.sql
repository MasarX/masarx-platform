-- Migration: FieldOps Mobile V2 pickup driver access
-- Date: 2026-05-27
-- Purpose:
--   Keep Mobile V2 pickup discoverability row-driven by granting pickup read
--   capability to driver runtime roles instead of bypassing ui_navigation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605271620_fieldops_mobile_v2_pickup_driver_access_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION pg_temp.fieldops_mobile_v2_pickup_driver_policy_v1(p_policy JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy JSONB := COALESCE(p_policy, '{}'::jsonb);
  v_caps JSONB := COALESCE(p_policy->'capabilities', '[]'::jsonb);
  v_roles JSONB := COALESCE(p_policy->'roles', '[]'::jsonb);
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_assignments JSONB := COALESCE(p_policy->'assignments', '{}'::jsonb);
  v_user_type_assignments JSONB := COALESCE(p_policy#>'{assignments,user_type}', '{}'::jsonb);
  v_role_name TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(v_caps) cap
     WHERE cap->>'key' = 'pickups.read'
  ) THEN
    v_caps := v_caps || jsonb_build_array(jsonb_build_object(
      'key', 'pickups.read',
      'label', 'Pickups read',
      'category', 'operate'
    ));
  END IF;

  FOREACH v_role_name IN ARRAY ARRAY['driver', 'fieldops_money_driver'] LOOP
    IF NOT (v_user_type_assignments ? v_role_name) THEN
      v_user_type_assignments := jsonb_set(
        v_user_type_assignments,
        ARRAY[v_role_name],
        jsonb_build_array(v_role_name),
        true
      );
    END IF;
  END LOOP;

  FOR v_role_idx IN 0 .. GREATEST(jsonb_array_length(v_roles) - 1, -1) LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' IN ('driver', 'fieldops_money_driver') THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF NOT (v_role_keys @> to_jsonb('pickups.read'::text))
         AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
        v_role_keys := v_role_keys || to_jsonb('pickups.read'::text);
      END IF;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, true);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, true);
    END IF;
  END LOOP;

  v_assignments := jsonb_set(v_assignments, '{user_type}', v_user_type_assignments, true);
  v_policy := jsonb_set(v_policy, '{capabilities}', v_caps, true);
  v_policy := jsonb_set(v_policy, '{roles}', v_roles, true);
  v_policy := jsonb_set(v_policy, '{assignments}', v_assignments, true);
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
    v_next := pg_temp.fieldops_mobile_v2_pickup_driver_policy_v1(v_rec.value);
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
      'FieldOps Mobile V2: grant pickup read access to driver runtime roles.',
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

SELECT pg_advisory_unlock(hashtext('202605271620_fieldops_mobile_v2_pickup_driver_access_v1'));
COMMIT;
