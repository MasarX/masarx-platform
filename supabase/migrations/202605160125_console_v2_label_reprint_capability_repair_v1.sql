-- Console V2 first-tenant readiness requires tenant operations admins to
-- reprint labels through the browser UI. Keep the backend access-control SSOT
-- aligned with the Console V2 capability bridge and label reprint RPC gate.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605160125_console_v2_label_reprint_capability_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_existing_active_id UUID;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
  v_changed BOOLEAN := FALSE;
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
  IF NOT EXISTS (
    SELECT 1
      FROM jsonb_array_elements(v_caps) cap
     WHERE cap->>'key' = 'labels.reprint'
  ) THEN
    v_caps := v_caps || jsonb_build_array(jsonb_build_object(
      'key', 'labels.reprint',
      'label', 'Labels reprint',
      'category', 'labels'
    ));
    v_changed := TRUE;
  END IF;

  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      IF NOT (v_role_keys @> to_jsonb('labels.reprint'::text))
         AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
        v_role_keys := v_role_keys || to_jsonb('labels.reprint'::text);
        v_changed := TRUE;
      END IF;

      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
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
    'Console V2: grant ops_admin label reprint capability',
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
$do$;

DO $do$
DECLARE
  v_rec RECORD;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_role_idx INTEGER;
  v_changed BOOLEAN;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  FOR v_rec IN
    SELECT id, category, scope_type, scope_id, value
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND approved_at IS NOT NULL
       AND effective_until IS NULL
       AND NOT (scope_type = 'global' AND scope_id IS NULL)
     ORDER BY scope_type, scope_id NULLS FIRST, version
  LOOP
    v_next := v_rec.value;
    v_changed := FALSE;
    v_caps := COALESCE(v_next->'capabilities', '[]'::jsonb);

    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) cap
       WHERE cap->>'key' = 'labels.reprint'
    ) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', 'labels.reprint',
        'label', 'Labels reprint',
        'category', 'labels'
      ));
      v_changed := TRUE;
    END IF;

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
      v_role := v_roles->v_role_idx;
      IF v_role->>'key' = 'ops_admin' THEN
        v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF NOT (v_role_keys @> to_jsonb('labels.reprint'::text))
           AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
          v_role_keys := v_role_keys || to_jsonb('labels.reprint'::text);
          v_changed := TRUE;
        END IF;

        v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
        v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
      END IF;
    END LOOP;

    IF NOT v_changed THEN
      CONTINUE;
    END IF;

    v_next := jsonb_set(jsonb_set(v_next, '{capabilities}', v_caps), '{roles}', v_roles);

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
      'Console V2: inherit ops_admin label reprint capability',
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
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202605160125_console_v2_label_reprint_capability_repair_v1'));
COMMIT;
