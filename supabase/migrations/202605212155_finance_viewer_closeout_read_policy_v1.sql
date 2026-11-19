-- Console V2 first-tenant Finance readiness: make the finance_viewer persona
-- read all core finance closeout surfaces while keeping write capabilities
-- denied. This allows lower-permission operators to inspect COD and
-- settlement closeout without gaining cashier, adjustment, or settlement
-- lifecycle authority.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605212155_finance_viewer_closeout_read_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_setting RECORD;
  v_next JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_assignments JSONB;
  v_user_type_assignments JSONB;
  v_cap TEXT;
  v_role_idx INT;
  v_new_version INT;
  v_new_version_id UUID;
  v_target_caps TEXT[] := ARRAY[
    'console_metadata.read',
    'finance.read',
    'cod.read',
    'settlements.read'
  ];
  v_denied_write_caps TEXT[] := ARRAY[
    'finance.write',
    'settlements.write',
    'workflow_runs.write'
  ];
BEGIN
  FOR v_setting IN
    SELECT
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
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

    FOREACH v_cap IN ARRAY v_target_caps LOOP
      IF NOT EXISTS (
        SELECT 1
        FROM jsonb_array_elements(v_caps) AS cap
        WHERE cap->>'key' = v_cap
      ) THEN
        v_caps := v_caps || jsonb_build_array(jsonb_build_object(
          'key', v_cap,
          'label', initcap(replace(v_cap, '.', ' ')),
          'category', split_part(v_cap, '.', 1)
        ));
      END IF;
    END LOOP;

    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_roles) AS role_item
      WHERE role_item->>'key' = 'finance_viewer'
    ) THEN
      v_roles := v_roles || jsonb_build_array(jsonb_build_object(
        'key', 'finance_viewer',
        'label', 'Finance Viewer',
        'capability_keys', to_jsonb(v_target_caps)
      ));
    END IF;

    FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
      v_role := v_roles->v_role_idx;
      IF v_role->>'key' = 'finance_viewer' THEN
        v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_keys) IS DISTINCT FROM 'array' THEN
          v_role_keys := '[]'::jsonb;
        END IF;

        FOREACH v_cap IN ARRAY v_denied_write_caps LOOP
          SELECT COALESCE(jsonb_agg(cap_key), '[]'::jsonb)
            INTO v_role_keys
            FROM jsonb_array_elements_text(v_role_keys) AS cap_key
           WHERE cap_key <> v_cap;
        END LOOP;

        FOREACH v_cap IN ARRAY v_target_caps LOOP
          IF NOT (v_role_keys @> to_jsonb(v_cap)) THEN
            v_role_keys := v_role_keys || to_jsonb(v_cap);
          END IF;
        END LOOP;

        v_role := jsonb_set(v_role, '{label}', to_jsonb('Finance Viewer'::text), true);
        v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys, true);
        v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role, true);
      END IF;
    END LOOP;

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
      '{finance_viewer}',
      '["finance_viewer"]'::jsonb,
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
        'Console V2 Finance Viewer: read-only COD and settlement closeout visibility',
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

SELECT pg_advisory_unlock(hashtext('202605212155_finance_viewer_closeout_read_policy_v1'));
COMMIT;
