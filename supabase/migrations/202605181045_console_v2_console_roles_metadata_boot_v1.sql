BEGIN;
SELECT pg_advisory_lock(hashtext('202605181045_console_v2_console_roles_metadata_boot_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_setting RECORD;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_new_roles JSONB;
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
    WHERE s.category = 'access_control_policy'
  LOOP
    v_next := COALESCE(v_setting.value, '{}'::jsonb);
    v_caps := COALESCE(v_next->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_caps) AS cap
      WHERE cap->>'key' = 'console_metadata.read'
    ) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', 'console_metadata.read',
        'label', 'Console Metadata Read',
        'category', 'console_metadata'
      ));
    END IF;

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    SELECT COALESCE(
      jsonb_agg(
        CASE
          WHEN role_item->>'key' IN ('ops_admin', 'account_manager', 'client_admin', 'sender_user')
           AND NOT EXISTS (
             SELECT 1
             FROM jsonb_array_elements_text(COALESCE(role_item->'capability_keys', '[]'::jsonb)) AS cap(capability_key)
             WHERE cap.capability_key = 'console_metadata.read'
           )
          THEN jsonb_set(
            role_item,
            '{capability_keys}',
            COALESCE(role_item->'capability_keys', '[]'::jsonb) || '["console_metadata.read"]'::jsonb,
            true
          )
          ELSE role_item
        END
      ),
      '[]'::jsonb
    )
    INTO v_new_roles
    FROM jsonb_array_elements(v_roles) AS role_item;

    v_next := jsonb_set(v_next, '{capabilities}', v_caps, true);
    v_next := jsonb_set(v_next, '{roles}', v_new_roles, true);

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
        'Console V2 metadata boot: grant shell metadata to canonical console roles',
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

SELECT pg_advisory_unlock(hashtext('202605181045_console_v2_console_roles_metadata_boot_v1'));
COMMIT;
