-- update_user_profile_v1 checks users.read before users.manage; keep
-- ops_admin aligned with both capability gates.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031610_ops_admin_users_read_capability_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_changed BOOLEAN := FALSE;
  v_existing_active_id UUID;
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
  IF NOT EXISTS (SELECT 1 FROM jsonb_array_elements(v_caps) cap WHERE cap->>'key' = 'users.read') THEN
    v_caps := v_caps || jsonb_build_array(jsonb_build_object(
      'key', 'users.read',
      'label', 'Users Read',
      'category', 'users'
    ));
    v_changed := TRUE;
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF NOT (v_role_keys @> to_jsonb('users.read'::text)) AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
        v_role_keys := v_role_keys || to_jsonb('users.read'::text);
        v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
        v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
        v_changed := TRUE;
      END IF;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN;
  END IF;

  v_current := jsonb_set(jsonb_set(v_current, '{capabilities}', v_caps), '{roles}', v_roles);

  UPDATE public.settings_versions
     SET effective_until = GREATEST(now(), effective_from + interval '1 millisecond')
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
    'B6 identity RPCs: repair ops_admin users.read grant',
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
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605031610_ops_admin_users_read_capability_repair_v1'));
COMMIT;
