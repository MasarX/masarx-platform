-- Spec-Issue: NETWORK W8 — close 100% gap on branches/zones canonical write RPCs
-- Step: W8-S01
-- Migration: Register canonical `branches.write` capability + branch_* resource_map.
-- Date: 2026-04-30
--
-- Why:
--   - The 12 NETWORK canonical write RPCs (branch_create_v1 / branch_update_v1 /
--     mark_branch_oos_v1 / branch_zone_assign_v1 / branch_zone_unassign_v1 /
--     branch_member_add_v1 / branch_member_remove_v1 /
--     branch_capacity_window_set_v1 / branch_coverage_window_upsert_v1 /
--     zone_create_v1 / zone_district_add_v1 / zone_district_remove_v1) call
--     `assert_capability_v1('branches.write')` and `assert_capability_v1('zones.write')`.
--   - `branches.write` is currently NOT registered in the global
--     access_control_policy capabilities array (only `zones.write` is).
--   - This migration adds it (resource ladder: ops_admin keeps writes; tenant
--     scope is enforced by RLS + body guard, not by capability).
--   - It also registers branch-* resources in the resource_map so future ladder
--     resolution does not hardcode capability strings.
--
-- Notes:
--   - Reuses the same idempotent merge pattern as
--     202601071220_access_control_policy_ui_resources.sql so re-running is safe.
--   - Adds capability to ops_admin role-template so existing seeded admins
--     receive it without manual rebinding.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604300200_access_control_branches_write_capability'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  v_current JSONB;
  v_caps JSONB := '[]'::jsonb;
  v_roles JSONB := '[]'::jsonb;
  v_resource_map JSONB := '{}'::jsonb;
  v_cap JSONB;
  v_role JSONB;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object('key','branches.read','label','Branches read','category','operations'),
    jsonb_build_object('key','branches.write','label','Branches write','category','operations')
  );
BEGIN
  SELECT sv.value
    INTO v_current
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE EXCEPTION 'access_control_policy global settings missing';
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_cap IN SELECT * FROM jsonb_array_elements(v_new_caps) LOOP
    IF NOT EXISTS (
      SELECT 1
      FROM jsonb_array_elements(v_caps) AS item
      WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
    END IF;
  END LOOP;

  v_roles := '[]'::jsonb;
  FOR v_role IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' IN ('ops_admin', 'agreements_admin') THEN
      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
          FROM (
            SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
            UNION ALL SELECT unnest(ARRAY[
              'branches.read','branches.write'
            ]) AS cap
          ) AS caps
          ORDER BY cap
        )),
        false
      );
    END IF;
    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  v_resource_map := COALESCE(v_current->'resource_map', '{}'::jsonb);
  IF NOT (v_resource_map ? 'branches') THEN
    v_resource_map := jsonb_set(v_resource_map, '{branches}', jsonb_build_object('read','branches.read','write','branches.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'branch_zones') THEN
    v_resource_map := jsonb_set(v_resource_map, '{branch_zones}', jsonb_build_object('read','branches.read','write','branches.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'branch_memberships') THEN
    v_resource_map := jsonb_set(v_resource_map, '{branch_memberships}', jsonb_build_object('read','branches.read','write','branches.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'branch_capacity_windows') THEN
    v_resource_map := jsonb_set(v_resource_map, '{branch_capacity_windows}', jsonb_build_object('read','branches.read','write','branches.write'), true);
  END IF;
  IF NOT (v_resource_map ? 'branch_coverage_windows') THEN
    v_resource_map := jsonb_set(v_resource_map, '{branch_coverage_windows}', jsonb_build_object('read','branches.read','write','branches.write'), true);
  END IF;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, true);
  v_current := jsonb_set(v_current, '{roles}', v_roles, true);
  v_current := jsonb_set(v_current, '{resource_map}', v_resource_map, true);

  WITH cur AS (
    SELECT s.settings_version_id,
           sv.version,
           sv.value,
           sv.schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
      AND s.scope_type = 'global'
      AND s.scope_id IS NULL
    LIMIT 1
  ),
  applied AS (
    UPDATE public.settings_versions sv
    SET value = v_current,
        version = cur.version + 1,
        change_reason = 'Register branches.read/branches.write + branch_* resource_map (W8 NETWORK 100% closure)',
        approved_at = now(),
        effective_from = now()
    FROM cur
    WHERE sv.id = cur.settings_version_id
      AND v_current IS DISTINCT FROM cur.value
    RETURNING sv.id, sv.value
  )
  UPDATE public.settings s
  SET cached_value = applied.value,
      last_updated = now()
  FROM applied
  WHERE s.category = 'access_control_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
    AND s.settings_version_id = applied.id;
END $$;

SELECT pg_advisory_unlock(hashtext('202604300200_access_control_branches_write_capability'));
COMMIT;
