-- Spec-Issue: W41 closure of W40 local-Supabase E2E findings (F1)
-- Step: W41-F1
-- Migration: Idempotency fixup for 202604280001_phase_b1_platform_rpcs_foundation_v1
--
-- W40 finding (P0):
--   docs/ops/evidence/2026-04-30/local-verify/migrate-soft.log
--     SOFT-FAIL 202604280001_phase_b1_platform_rpcs_foundation_v1.sql:
--       duplicate key value violates unique constraint
--       "settings_versions_new_p0_category_scope_type_scope_hash_idx"
--
-- Root cause:
--   The B1 foundation migration appends six new capabilities
--   (alerts.read/write, feature_flags.read/write, warehouse.read/write) to the
--   global access_control_policy by inserting a new row into
--   public.settings_versions WITHOUT first updating the previous active row's
--   effective_until.
--
--   The unique partial index
--     idx_settings_versions_new_current
--     (category, scope_type, scope_hash) WHERE effective_until IS NULL AND approved_at IS NOT NULL
--   (auto-named on the partition as
--    settings_versions_new_p0_category_scope_type_scope_hash_idx)
--   rejects the second active row.
--
-- Canonical pattern (reference: 202601092055_workflow_defaults_max_steps_per_tick.sql):
--   1. UPDATE the currently effective settings_versions row to
--      effective_until = now() to retire it BEFORE inserting the new one.
--   2. Then INSERT the new approved version.
--
-- This fixup is idempotent: it inspects the current cap set, only creates a
-- new version when at least one of the six target caps is missing, and
-- always retires any existing active row first to satisfy the unique index.
--
-- Append-only: this migration creates no new objects; it only repairs the
-- access_control_policy row history if the B1 migration soft-failed. If the
-- B1 migration's INSERT succeeded on a prior run, this migration is a no-op.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605010001_w41_settings_versions_fixup_p1_b1_idempotency'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $w41_f1$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB;
  v_role JSONB;
  v_role_keys JSONB;
  v_idx INT;
  v_role_idx INT;
  v_existing_keys TEXT[] := ARRAY[]::TEXT[];
  v_target_caps TEXT[] := ARRAY[
    'alerts.read',
    'alerts.write',
    'feature_flags.read',
    'feature_flags.write',
    'warehouse.read',
    'warehouse.write'
  ];
  v_new_cap TEXT;
  v_changed BOOLEAN := FALSE;
  v_next_version INT;
  v_existing_active RECORD;
  v_sv_id UUID := gen_random_uuid();
  v_scope_hash UUID;
BEGIN
  -- Read currently effective row (if any) for access_control_policy / global.
  SELECT id, value, scope_hash
    INTO v_existing_active
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
     AND approved_at IS NOT NULL
     AND effective_until IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_existing_active.id IS NULL THEN
    -- No active access_control_policy row: nothing to extend yet. The B1
    -- foundation migration's RETURN-when-NULL guard handled this case the
    -- first time. We must remain a no-op here so we don't create a partial
    -- policy outside its dependency chain.
    RAISE NOTICE 'W41 F1: no active access_control_policy row; nothing to fixup';
    RETURN;
  END IF;

  v_current := v_existing_active.value;
  v_scope_hash := v_existing_active.scope_hash;

  -- Collect existing capability keys.
  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
    v_existing_keys := array_append(v_existing_keys, COALESCE(v_caps->v_idx->>'key', ''));
  END LOOP;

  -- Determine if any target cap is missing.
  FOREACH v_new_cap IN ARRAY v_target_caps LOOP
    IF NOT (v_new_cap = ANY(v_existing_keys)) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_new_cap,
        'label', initcap(replace(replace(v_new_cap, '.', ' '), '_', ' '))
      ));
      v_changed := TRUE;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    -- All six capabilities already registered: B1 migration's prior run
    -- succeeded (or this fixup ran before). No-op.
    RAISE NOTICE 'W41 F1: target caps already present; no-op';
    RETURN;
  END IF;

  -- Append target caps to ops_admin role's capability_keys.
  v_roles := COALESCE(v_current->'roles', '[]'::jsonb);
  FOR v_role_idx IN 0 .. jsonb_array_length(v_roles) - 1 LOOP
    v_role := v_roles->v_role_idx;
    IF v_role->>'key' = 'ops_admin' THEN
      v_role_keys := COALESCE(v_role->'capability_keys', '[]'::jsonb);
      FOREACH v_new_cap IN ARRAY v_target_caps LOOP
        IF NOT (v_role_keys @> to_jsonb(v_new_cap)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_new_cap);
        END IF;
      END LOOP;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  -- Retire the currently active row BEFORE inserting the new one
  -- (canonical pattern: settles the partial unique index correctly).
  UPDATE public.settings_versions
     SET effective_until = now()
   WHERE id = v_existing_active.id;

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  INSERT INTO public.settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    scope_hash,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  ) VALUES (
    v_sv_id,
    'access_control_policy',
    'global',
    NULL::uuid,
    COALESCE(v_scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
    v_next_version,
    v_current,
    1,
    'W41 F1 fixup: B1 platform RPCs register alerts/feature_flags/warehouse capabilities (idempotent retire-then-insert)',
    now(),
    now()
  );

  -- Refresh settings cache row. The settings table has TWO unique
  -- constraints (category, scope_type, scope_id) AND
  -- (category, scope_type, scope_hash); using ON CONFLICT (cat, scope_type,
  -- scope_id) misses the scope_hash constraint and raises 23505 on global
  -- rows where scope_id is NULL. Use explicit UPDATE-then-INSERT instead.
  UPDATE public.settings
     SET settings_version_id = v_sv_id,
         cached_value = v_current,
         last_updated = now()
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  IF NOT FOUND THEN
    INSERT INTO public.settings (
      category, scope_type, scope_id, scope_hash,
      settings_version_id, cached_value, last_updated
    ) VALUES (
      'access_control_policy', 'global', NULL,
      COALESCE(v_scope_hash, '00000000-0000-0000-0000-000000000000'::uuid),
      v_sv_id, v_current, now()
    );
  END IF;

  RAISE NOTICE 'W41 F1: registered access_control_policy v% with B1 capabilities', v_next_version;
END
$w41_f1$;

SELECT pg_advisory_unlock(hashtext('202605010001_w41_settings_versions_fixup_p1_b1_idempotency'));

COMMIT;
