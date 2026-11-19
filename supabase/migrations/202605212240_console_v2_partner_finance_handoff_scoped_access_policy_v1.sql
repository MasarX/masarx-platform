-- Migration: Console V2 partner finance handoff scoped access-policy repair
-- Purpose:
--   Existing tenants may carry scoped access_control_policy settings that
--   override the repaired global ops_admin marketplace grants. Repair the
--   active scoped policies too so first-tenant operators can reach Partners
--   and Marketplace through the same backend-backed capability gate.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605212240_console_v2_partner_finance_handoff_scoped_access_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $scoped_access_policy$
DECLARE
  v_row RECORD;
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
  v_changed BOOLEAN;
  v_new_settings_version_id UUID;
  v_next_version INTEGER;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      s.scope_type,
      s.scope_id,
      sv.version,
      sv.schema_version,
      COALESCE(sv.value, s.cached_value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv
      ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND sv.approved_at IS NOT NULL
      AND sv.effective_until IS NULL
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    v_changed := FALSE;
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
      CONTINUE;
    END IF;

    v_current := jsonb_set(v_current, '{capabilities}', v_caps, TRUE);
    v_current := jsonb_set(v_current, '{roles}', v_roles, TRUE);

    UPDATE public.settings_versions
       SET effective_until = CASE
             WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
             ELSE now()
           END,
           updated_at = now()
     WHERE id = v_row.settings_version_id;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM public.settings_versions
     WHERE category = 'access_control_policy'
       AND scope_type = v_row.scope_type
       AND scope_id IS NOT DISTINCT FROM v_row.scope_id;

    INSERT INTO public.settings_versions (
      category,
      scope_type,
      scope_id,
      version,
      value,
      schema_version,
      change_reason,
      approved_at,
      effective_from
    ) VALUES (
      'access_control_policy',
      v_row.scope_type,
      v_row.scope_id,
      v_next_version,
      v_current,
      COALESCE(v_row.schema_version, 1),
      'Console V2 partner finance handoff: repair scoped ops_admin marketplace grants',
      now(),
      now()
    )
    RETURNING id INTO v_new_settings_version_id;

    UPDATE public.settings
       SET settings_version_id = v_new_settings_version_id,
           cached_value = v_current,
           last_updated = now()
     WHERE id = v_row.settings_id;
  END LOOP;

  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$scoped_access_policy$;

SELECT pg_advisory_unlock(hashtext('202605212240_console_v2_partner_finance_handoff_scoped_access_policy_v1'));

COMMIT;
