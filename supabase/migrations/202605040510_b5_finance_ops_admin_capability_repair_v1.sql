-- Repair Phase B5 access-control policy so ops_admin receives the complete
-- finance read/write set, including pre-existing finance.write used by bank
-- recon and finance.read used by bank-account balance projections.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031560_b5_finance_ops_admin_capability_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $do$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_cap TEXT;
  v_role_idx INTEGER;
  v_cap_keys TEXT[] := ARRAY[]::TEXT[];
  v_target_caps TEXT[] := ARRAY[
    'finance.read',
    'finance.write',
    'billing.write',
    'invoices.send',
    'invoices.refund',
    'settlements.write',
    'disputes.write'
  ];
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
     SET effective_until = now()
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
    'B5 finance RPCs: repair ops_admin finance capability grants',
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

SELECT pg_advisory_unlock(hashtext('202605031560_b5_finance_ops_admin_capability_repair_v1'));
COMMIT;
