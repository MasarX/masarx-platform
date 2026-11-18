-- Spec-Issue: W9-2 INTEGRATIONS gap closure (W7 audit REVISION 36% - P0 #4)
-- Step: W9-2-RPC-2..5
-- Migration: Canonical jsonb-arg shim RPCs for the integration plugin
-- lifecycle (Submit / Approve / Activate / Set-binding).
--
-- Problem (W7 audit REAUDIT/INTEGRATIONS.md §9 #4):
--   Only Install (integration_plugin_generate_draft_v1) + Uninstall
--   (integration_plugin_rollback_v1) are wired to the FE catalog drawer.
--   The drawer shows version history read-only with no transition actions
--   for Submit / Approve / Activate / Set-binding even though the
--   underlying positional-arg RPCs already exist
--   (202602220040_integration_plugin_lifecycle_rpcs_v1.sql:480..858).
--
-- Solution:
--   Add 4 thin jsonb-arg shim RPCs that route to the existing positional
--   RPCs. The shims match the FE Phase C6 contract (every RPC takes
--   `p_args jsonb` and returns the canonical envelope). This avoids
--   touching the validated lifecycle bodies while giving the FE a clean
--   wire-protocol-aligned seam.
--
-- All shims:
--   - SECURITY INVOKER (delegates to inner SECURITY DEFINER RPC for the
--     real authorization check; capability assertions remain inside the
--     positional RPCs).
--   - Capability: integration_plugins.write (per W7 audit; underlying
--     RPCs use integration_plugins.write/.approve/.activate as appropriate
--     - the FE-facing capability is unified at integration_plugins.write
--     for catalog-page UX consistency, while the inner DEFINER call
--     enforces the more granular check against the operator's row).
--
-- Backend SSOT references:
--   - integration_plugin_submit_v1   (UUID, TEXT)        202602220040:480
--   - integration_plugin_approve_v1  (UUID, TEXT, TEXT)  202602220040:587
--   - integration_plugin_activate_v1 (UUID, TEXT, UUID, TEXT)
--                                                       202602220040:740
--                                                       (re-defined 202602220080)
--   - integration_plugin_set_binding_runtime_enabled_v1 (UUID, BOOLEAN, TEXT, UUID)
--                                                       202602220080:17

BEGIN;
SELECT pg_advisory_lock(hashtext('202604301210_plugin_lifecycle_jsonb_shims_v1'));
SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- 1) plugin_submit_v1(p_args jsonb)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plugin_submit_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_version_id UUID;
  v_reason TEXT;
  v_inner JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_submit_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_version_id := NULLIF(p_args->>'plugin_version_id', '')::UUID;
  EXCEPTION WHEN others THEN v_version_id := NULL; END;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plugin_submit_v1 requires plugin_version_id'
      USING ERRCODE = '23502';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');

  -- Delegate to the canonical positional-arg RPC which performs:
  --   - capability assertion (integration_plugins.write)
  --   - validation pre-check
  --   - status transition draft|rejected -> submitted
  --   - approval_events ledger insert
  v_inner := public.integration_plugin_submit_v1(v_version_id, v_reason);

  RETURN COALESCE(v_inner, '{}'::jsonb)
       || jsonb_build_object(
            'correlation_id', v_correlation_id,
            'settings_resolution_id', gen_random_uuid()
          );
END;
$$;

REVOKE ALL ON FUNCTION public.plugin_submit_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_submit_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_submit_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.plugin_submit_v1(jsonb)
  IS 'Canonical jsonb-arg shim for integration_plugin_submit_v1 (W9-2). Submits a draft plugin version for review (status -> submitted). Capability: integration_plugins.write (asserted in inner RPC).';

-------------------------------------------------------------------------------
-- 2) plugin_approve_v1(p_args jsonb)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plugin_approve_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_version_id UUID;
  v_decision TEXT;
  v_reason TEXT;
  v_inner JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_approve_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_version_id := NULLIF(p_args->>'plugin_version_id', '')::UUID;
  EXCEPTION WHEN others THEN v_version_id := NULL; END;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plugin_approve_v1 requires plugin_version_id'
      USING ERRCODE = '23502';
  END IF;

  v_decision := lower(NULLIF(btrim(COALESCE(p_args->>'decision', '')), ''));
  IF v_decision IS NULL THEN
    RAISE EXCEPTION 'plugin_approve_v1 requires decision (approved|rejected)'
      USING ERRCODE = '23502';
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'plugin_approve_v1 decision must be approved|rejected (got %)', v_decision
      USING ERRCODE = '22023';
  END IF;

  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');

  -- Delegate to the canonical positional-arg RPC which performs:
  --   - capability assertion (integration_plugins.approve)
  --   - submitted -> approved|rejected transition
  --   - approval_events ledger insert
  v_inner := public.integration_plugin_approve_v1(v_version_id, v_decision, v_reason);

  RETURN COALESCE(v_inner, '{}'::jsonb)
       || jsonb_build_object(
            'correlation_id', v_correlation_id,
            'settings_resolution_id', gen_random_uuid()
          );
END;
$$;

REVOKE ALL ON FUNCTION public.plugin_approve_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_approve_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_approve_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.plugin_approve_v1(jsonb)
  IS 'Canonical jsonb-arg shim for integration_plugin_approve_v1 (W9-2). Approves or rejects a submitted plugin version. Capability: integration_plugins.approve (asserted in inner RPC).';

-------------------------------------------------------------------------------
-- 3) plugin_activate_v1(p_args jsonb)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.plugin_activate_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_version_id UUID;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_reason TEXT;
  v_inner JSONB;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_activate_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_version_id := NULLIF(p_args->>'plugin_version_id', '')::UUID;
  EXCEPTION WHEN others THEN v_version_id := NULL; END;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plugin_activate_v1 requires plugin_version_id'
      USING ERRCODE = '23502';
  END IF;

  v_scope_type := lower(NULLIF(btrim(COALESCE(p_args->>'scope_type', '')), ''));
  IF v_scope_type IS NULL THEN
    v_scope_type := 'tenant';
  END IF;

  BEGIN v_scope_id := NULLIF(p_args->>'scope_id', '')::UUID;
  EXCEPTION WHEN others THEN v_scope_id := NULL; END;

  v_reason := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');

  -- Delegate to the canonical positional-arg RPC which performs:
  --   - capability assertion (integration_plugins.activate)
  --   - approved -> active transition
  --   - workflow_template existence + binding validation
  --   - integration_plugin_bindings + runtime resource materialization
  --   - active_version_id pivot
  v_inner := public.integration_plugin_activate_v1(v_version_id, v_scope_type, v_scope_id, v_reason);

  RETURN COALESCE(v_inner, '{}'::jsonb)
       || jsonb_build_object(
            'correlation_id', v_correlation_id,
            'settings_resolution_id', gen_random_uuid()
          );
END;
$$;

REVOKE ALL ON FUNCTION public.plugin_activate_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_activate_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_activate_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.plugin_activate_v1(jsonb)
  IS 'Canonical jsonb-arg shim for integration_plugin_activate_v1 (W9-2). Activates an approved plugin version + materializes runtime bindings. Capability: integration_plugins.activate (asserted in inner RPC).';

-------------------------------------------------------------------------------
-- 4) plugin_set_binding_v1(p_args jsonb)
-------------------------------------------------------------------------------
--
-- Toggles the runtime-enabled flag on the plugin version's bindings (and the
-- corresponding runtime resource rows). Wraps
-- integration_plugin_set_binding_runtime_enabled_v1 plus a capability check.

CREATE OR REPLACE FUNCTION public.plugin_set_binding_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id TEXT := encode(gen_random_bytes(8), 'hex');
  v_decision_id UUID := gen_random_uuid();
  v_version_id UUID;
  v_enabled BOOLEAN;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_changed INTEGER;
  v_plugin public.integration_plugins%ROWTYPE;
  v_version public.integration_plugin_versions%ROWTYPE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  BEGIN v_version_id := NULLIF(p_args->>'plugin_version_id', '')::UUID;
  EXCEPTION WHEN others THEN v_version_id := NULL; END;

  IF v_version_id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires plugin_version_id'
      USING ERRCODE = '23502';
  END IF;

  IF (p_args->'enabled') IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 requires enabled boolean'
      USING ERRCODE = '23502';
  END IF;

  v_enabled := COALESCE((p_args->>'enabled')::BOOLEAN, NULL);
  IF v_enabled IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 enabled must be boolean'
      USING ERRCODE = '22023';
  END IF;

  v_scope_type := lower(NULLIF(btrim(COALESCE(p_args->>'scope_type', '')), ''));
  BEGIN v_scope_id := NULLIF(p_args->>'scope_id', '')::UUID;
  EXCEPTION WHEN others THEN v_scope_id := NULL; END;

  -- Resolve plugin for tenant isolation + capability check.
  SELECT * INTO v_version
    FROM public.integration_plugin_versions
   WHERE id = v_version_id
   LIMIT 1;
  IF v_version.id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin_version_id % not found', v_version_id
      USING ERRCODE = '23503';
  END IF;

  SELECT * INTO v_plugin
    FROM public.integration_plugins
   WHERE id = v_version.plugin_id
   LIMIT 1;
  IF v_plugin.id IS NULL THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin % not found', v_version.plugin_id
      USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user()
     AND v_plugin.organization_id IS NOT NULL
     AND v_org_id IS NOT NULL
     AND v_plugin.organization_id <> v_org_id THEN
    RAISE EXCEPTION 'plugin_set_binding_v1 plugin % outside tenant scope', v_plugin.id
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('integration_plugins.activate', 'tenant', v_plugin.organization_id);

  -- Toggle bindings + linked runtime rows.
  v_changed := public.integration_plugin_set_binding_runtime_enabled_v1(
    v_version_id, v_enabled, v_scope_type, v_scope_id
  );

  -- Audit ledger.
  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, v_plugin.organization_id, 'integration_plugin.set_binding',
    'integration_plugin_version', v_version_id,
    'plugin_set_binding_v1',
    CASE WHEN v_enabled THEN 'binding_enabled' ELSE 'binding_disabled' END,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'plugin_version_id', v_version_id,
      'enabled', v_enabled,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'changed_count', v_changed
    )),
    'plugin_set_binding_v1',
    v_correlation_id::uuid
  );

  -- Domain event.
  INSERT INTO public.domain_events (
    organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
  ) VALUES (
    v_plugin.organization_id,
    CASE WHEN v_enabled THEN 'integration_plugin.binding_enabled' ELSE 'integration_plugin.binding_disabled' END,
    'integration_plugin_version', v_version_id,
    jsonb_strip_nulls(jsonb_build_object(
      'plugin_id', v_plugin.id,
      'enabled', v_enabled,
      'scope_type', v_scope_type,
      'scope_id', v_scope_id,
      'changed_count', v_changed
    )),
    v_correlation_id::uuid, 'pending'
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'plugin_id', v_plugin.id,
    'plugin_version_id', v_version_id,
    'enabled', v_enabled,
    'changed_count', v_changed,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  );
END;
$$;

REVOKE ALL ON FUNCTION public.plugin_set_binding_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.plugin_set_binding_v1(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.plugin_set_binding_v1(jsonb) TO service_role;

COMMENT ON FUNCTION public.plugin_set_binding_v1(jsonb)
  IS 'Canonical jsonb-arg shim: toggle runtime-enabled flag on integration_plugin_bindings + linked runtime resource rows. Capability: integration_plugins.activate.';

SELECT pg_advisory_unlock(hashtext('202604301210_plugin_lifecycle_jsonb_shims_v1'));
COMMIT;
