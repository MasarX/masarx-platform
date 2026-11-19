-- Spec-Issue: Phase B5 - FINANCE RPCs canonical contracts
-- Step: B5-Foundation
-- Migration: Capability registry seed for Phase B5 FINANCE RPCs.
-- Date: 2026-04-28
--
-- Purpose:
--   Register canonical capabilities used by Phase B5 RPCs in the global
--   access_control_policy SSOT, and grant them to the ops_admin role so
--   the new FINANCE RPCs pass the capability gate by default.
--
--   New capabilities seeded:
--     - billing.read         (read billing invoices/lines/events)
--     - billing.write        (create/update/void/cancel billing invoices + subscriptions)
--     - invoices.send        (broadcast issued invoice)
--     - invoices.refund      (refund issued invoice)
--     - settlements.read     (read settlement batches/events)
--     - settlements.write    (apply/reject settlement batches)
--     - disputes.read        (read finance disputes)
--     - disputes.write       (resolve/reject finance disputes — see notes below)
--
-- Notes:
--   * `finance.write` already exists (rbac_foundation_v1) and is reused for
--     bank reconciliation match/unmatch RPCs.
--   * `disputes.write` is a NEW capability introduced for the FINANCE
--     domain dispute resolve/reject surface. The existing
--     `marketplace_disputes.write` capability lives in the MARKETPLACE
--     namespace; the FE finance/disputes module audit referenced
--     `disputes.read` only, but resolving/rejecting disputes is a
--     mutation — so we introduce `disputes.write` as the canonical key
--     rather than abusing a read capability for write paths.
--   * Capability registration is idempotent: re-running the migration is
--     safe and only updates the policy when the keys are missing.
--   * Cap registration is row-driven through the access_control_policy
--     SSOT (no hardcoded role/cap branching anywhere in the RPC bodies).
--
-- Append-only: new capability rows + new role.capability_keys entries.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281000_phase_b5_finance_caps_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $do$
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
    'billing.read',
    'billing.write',
    'invoices.send',
    'invoices.refund',
    'settlements.read',
    'settlements.write',
    'disputes.read',
    'disputes.write'
  ];
  v_new_cap TEXT;
  v_changed BOOLEAN := FALSE;
  v_next_version INT;
BEGIN
  SELECT value INTO v_current
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   ORDER BY version DESC
   LIMIT 1;

  IF v_current IS NULL THEN
    -- access_control_policy global seed missing; nothing to extend.
    RETURN;
  END IF;

  -- Collect existing capability keys
  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  IF jsonb_typeof(v_caps) IS DISTINCT FROM 'array' THEN
    v_caps := '[]'::jsonb;
  END IF;

  FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
    v_existing_keys := array_append(v_existing_keys, COALESCE(v_caps->v_idx->>'key', ''));
  END LOOP;

  -- Append any missing target caps
  FOREACH v_new_cap IN ARRAY v_target_caps LOOP
    IF NOT (v_new_cap = ANY(v_existing_keys)) THEN
      v_caps := v_caps || jsonb_build_array(jsonb_build_object(
        'key', v_new_cap,
        'label', initcap(replace(replace(v_new_cap, '.', ' '), '_', ' ')),
        'category', split_part(v_new_cap, '.', 1)
      ));
      v_changed := TRUE;
    END IF;
  END LOOP;

  IF NOT v_changed THEN
    RETURN;
  END IF;

  -- Grant the new caps to ops_admin role (super_admin already has '*' wildcard).
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
      FOREACH v_new_cap IN ARRAY v_target_caps LOOP
        IF NOT (v_role_keys @> to_jsonb(v_new_cap))
           AND NOT (v_role_keys @> to_jsonb('*'::text)) THEN
          v_role_keys := v_role_keys || to_jsonb(v_new_cap);
        END IF;
      END LOOP;
      v_role := jsonb_set(v_role, '{capability_keys}', v_role_keys);
      v_roles := jsonb_set(v_roles, ARRAY[v_role_idx::text], v_role);
    END IF;
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps);
  v_current := jsonb_set(v_current, '{roles}', v_roles);

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  UPDATE public.settings_versions
     SET effective_until = CASE
           WHEN now() <= effective_from THEN effective_from + interval '1 microsecond'
           ELSE now()
         END
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
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
  ) VALUES (
    'access_control_policy',
    'global',
    NULL::uuid,
    v_next_version,
    v_current,
    1,
    'B5 finance RPCs: register billing/invoices/settlements/disputes capabilities and grant to ops_admin',
    now()
  );

  -- Refresh settings cache (point the public.settings row at the new version).
  INSERT INTO public.settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    sv.category,
    sv.scope_type,
    sv.scope_id,
    COALESCE(sv.scope_id, '00000000-0000-0000-0000-000000000000'::uuid),
    sv.id,
    sv.value,
    now()
    FROM public.settings_versions sv
   WHERE sv.category = 'access_control_policy'
     AND sv.scope_type = 'global'
     AND sv.scope_id IS NULL
     AND sv.version = v_next_version
  ON CONFLICT ON CONSTRAINT settings_scope_hash_unique
  DO UPDATE SET
    settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;
END;
$do$;

SELECT pg_advisory_unlock(hashtext('202604281000_phase_b5_finance_caps_v1'));
COMMIT;
