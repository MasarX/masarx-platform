-- Plan: frontend-design / Phase B / Subagent B3
-- Migration: Access control policy support.read / support.write capability seed v1
-- Date: 2026-04-27
--
-- Purpose:
--   - Register canonical support.read / support.write capabilities in
--     access_control_policy.capabilities (SSOT capability registry).
--   - Map ops_admin to support.read + support.write so the new SUPPORT RPCs
--     pass capability gates by default (configuration-driven, not hardcoded
--     in the RPC bodies).
--   - Register resource_map.support_cases so resource-based access flows
--     through the canonical capability keys.
--
-- Notes:
--   - Append-only: existing role caps preserved; only adds the new keys.
--   - Idempotent: safe to re-run; merges via deep_merge_jsonb.
--   - No hardcoded role privileges in RPC bodies; everything resolves through
--     access_control_policy + assert_capability_v1.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604271215_access_control_policy_support_caps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
DECLARE
  v_support_read_cap JSONB := jsonb_build_object(
    'key', 'support.read',
    'label', 'Support cases read',
    'description', 'Read support cases, messages, tags, and projection summary.'
  );
  v_support_write_cap JSONB := jsonb_build_object(
    'key', 'support.write',
    'label', 'Support cases write',
    'description', 'Create, update, assign, resolve, reopen support cases and append messages/tags.'
  );
  v_support_resource_map JSONB := jsonb_build_object(
    'read', 'support.read',
    'write', 'support.write'
  );

  v_row RECORD;
  v_current JSONB := NULL;
  v_next JSONB := NULL;
  v_caps JSONB := '[]'::jsonb;
  v_next_caps JSONB := '[]'::jsonb;
  v_cap JSONB;
  v_cap_key TEXT := NULL;
  v_roles JSONB := '[]'::jsonb;
  v_next_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_role_key TEXT := NULL;
  v_role_caps JSONB := '[]'::jsonb;

  -- target capability keys we want ops_admin to have by default
  v_target_keys TEXT[] := ARRAY['support.read', 'support.write'];
  v_target_key TEXT;
BEGIN
  FOR v_row IN
    SELECT
      s.id AS settings_id,
      s.settings_version_id,
      sv.version,
      sv.value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'access_control_policy'
  LOOP
    v_current := COALESCE(v_row.value, '{}'::jsonb);
    IF jsonb_typeof(v_current) IS DISTINCT FROM 'object' THEN
      CONTINUE;
    END IF;

    -- 1) Merge or insert support.read / support.write into capabilities[].
    v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
    IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
      v_caps := '[]'::jsonb;
    END IF;

    v_next_caps := '[]'::jsonb;
    FOR v_cap IN
      SELECT value FROM jsonb_array_elements(v_caps) AS value
    LOOP
      v_cap_key := lower(NULLIF(btrim(COALESCE(v_cap->>'key', '')), ''));
      IF v_cap_key = 'support.read' THEN
        v_cap := public.deep_merge_jsonb(v_support_read_cap, v_cap);
      ELSIF v_cap_key = 'support.write' THEN
        v_cap := public.deep_merge_jsonb(v_support_write_cap, v_cap);
      END IF;
      v_next_caps := v_next_caps || jsonb_build_array(v_cap);
    END LOOP;

    -- Append any missing canonical caps.
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_next_caps) AS item
      WHERE lower(COALESCE(item->>'key', '')) = 'support.read'
    ) THEN
      v_next_caps := v_next_caps || jsonb_build_array(v_support_read_cap);
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM jsonb_array_elements(v_next_caps) AS item
      WHERE lower(COALESCE(item->>'key', '')) = 'support.write'
    ) THEN
      v_next_caps := v_next_caps || jsonb_build_array(v_support_write_cap);
    END IF;

    v_next := jsonb_set(v_current, '{capabilities}', v_next_caps, TRUE);

    -- 2) resource_map.support_cases -> read/write keys
    v_next := jsonb_set(
      v_next,
      '{resource_map,support_cases}',
      public.deep_merge_jsonb(
        COALESCE(v_next#>'{resource_map,support_cases}', '{}'::jsonb),
        v_support_resource_map
      ),
      TRUE
    );

    -- 3) Add support.read + support.write to ops_admin role.capability_keys.
    v_roles := COALESCE(v_next->'roles', '[]'::jsonb);
    IF jsonb_typeof(v_roles) IS DISTINCT FROM 'array' THEN
      v_roles := '[]'::jsonb;
    END IF;

    v_next_roles := '[]'::jsonb;
    FOR v_role IN
      SELECT value FROM jsonb_array_elements(v_roles) AS value
    LOOP
      v_role_key := lower(NULLIF(btrim(COALESCE(v_role->>'key', '')), ''));
      IF v_role_key = 'ops_admin' THEN
        v_role_caps := COALESCE(v_role->'capability_keys', '[]'::jsonb);
        IF jsonb_typeof(v_role_caps) IS DISTINCT FROM 'array' THEN
          v_role_caps := '[]'::jsonb;
        END IF;

        FOREACH v_target_key IN ARRAY v_target_keys
        LOOP
          IF NOT EXISTS (
            SELECT 1 FROM jsonb_array_elements_text(v_role_caps) AS value
            WHERE value = '*' OR lower(value) = v_target_key
          ) THEN
            v_role_caps := v_role_caps || jsonb_build_array(v_target_key);
          END IF;
        END LOOP;

        v_role := jsonb_set(v_role, '{capability_keys}', v_role_caps, TRUE);
      END IF;

      v_next_roles := v_next_roles || jsonb_build_array(v_role);
    END LOOP;

    v_next := jsonb_set(v_next, '{roles}', v_next_roles, TRUE);

    IF v_next IS DISTINCT FROM v_current THEN
      UPDATE public.settings_versions
         SET value = v_next,
             version = v_row.version + 1,
             change_reason = 'Seed support.read/support.write capabilities and grant to ops_admin (Phase B3 SUPPORT RPCs).',
             approved_at = workflow_now(),
             effective_from = workflow_now()
       WHERE id = v_row.settings_version_id;

      UPDATE public.settings
         SET cached_value = v_next,
             last_updated = workflow_now()
       WHERE id = v_row.settings_id;
    END IF;
  END LOOP;

  -- Bust capability resolution cache so the new caps are visible immediately.
  DELETE FROM public.settings_cache
   WHERE cache_key LIKE 'access_control_policy:%';
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604271215_access_control_policy_support_caps_v1'));
COMMIT;
