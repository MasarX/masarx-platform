-- Spec-Issue: Phase B1 - Platform RPCs canonical contracts
-- Step: B1-Foundation
-- Migration: Foundation tables + capability registry for B1 platform RPCs.
-- Purpose:
--   * Register canonical capabilities used by Phase B1 RPCs (alerts.read/write,
--     feature_flags.read/write, warehouse.read/write).
--   * Add soft-delete support to public.alert_rules via deleted_at column.
--   * Create supporting append-only ledgers required by B1 RPC contracts:
--       - public.alert_rule_revisions   (audit trail of update_alert_rule_v1)
--       - public.ops_alert_events       (acknowledge/resolve audit ledger)
--       - public.feature_flag_kill_events (kill-switch audit ledger)
--       - public.capability_grant_requests (access_policy.request workflow ledger)
--   * Each ledger has explicit RLS, service_role policy, no anon/authenticated grants.
--
-- Append-only: this migration creates new objects only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280001_phase_b1_platform_rpcs_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Soft-delete + guard columns on public.alert_rules
-------------------------------------------------------------------------------

ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS deleted_by UUID NULL;

ALTER TABLE public.alert_rules
  ADD COLUMN IF NOT EXISTS updated_by UUID NULL;

CREATE INDEX IF NOT EXISTS idx_alert_rules_active
  ON public.alert_rules (organization_id, enabled)
  WHERE deleted_at IS NULL;

-------------------------------------------------------------------------------
-- 2) public.alert_rule_revisions (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.alert_rule_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  alert_rule_id UUID NOT NULL REFERENCES public.alert_rules(id) ON DELETE CASCADE,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  before_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT alert_rule_revisions_revision_ck CHECK (revision >= 1),
  CONSTRAINT alert_rule_revisions_unique UNIQUE (alert_rule_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_alert_rule_revisions_rule
  ON public.alert_rule_revisions (alert_rule_id, revision DESC);

CREATE INDEX IF NOT EXISTS idx_alert_rule_revisions_org
  ON public.alert_rule_revisions (organization_id, created_at DESC);

COMMENT ON TABLE public.alert_rule_revisions
  IS 'Append-only audit trail of update_alert_rule_v1 mutations (before/after diffs).';

ALTER TABLE public.alert_rule_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.alert_rule_revisions FROM PUBLIC;
REVOKE ALL ON TABLE public.alert_rule_revisions FROM anon;
REVOKE ALL ON TABLE public.alert_rule_revisions FROM authenticated;
GRANT ALL ON TABLE public.alert_rule_revisions TO service_role;

DROP POLICY IF EXISTS alert_rule_revisions_service_policy ON public.alert_rule_revisions;
CREATE POLICY alert_rule_revisions_service_policy
  ON public.alert_rule_revisions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 3) public.ops_alert_events (append-only ack/resolve ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.ops_alert_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ops_alert_id UUID NOT NULL,
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  notes TEXT NULL,
  acted_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT ops_alert_events_event_type_ck
    CHECK (event_type IN ('acknowledged','resolved','reopened','escalated'))
);

CREATE INDEX IF NOT EXISTS idx_ops_alert_events_alert
  ON public.ops_alert_events (ops_alert_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_ops_alert_events_org
  ON public.ops_alert_events (organization_id, created_at DESC);

COMMENT ON TABLE public.ops_alert_events
  IS 'Append-only audit ledger for ops_alerts ack/resolve transitions.';

ALTER TABLE public.ops_alert_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.ops_alert_events FROM PUBLIC;
REVOKE ALL ON TABLE public.ops_alert_events FROM anon;
REVOKE ALL ON TABLE public.ops_alert_events FROM authenticated;
GRANT ALL ON TABLE public.ops_alert_events TO service_role;

DROP POLICY IF EXISTS ops_alert_events_service_policy ON public.ops_alert_events;
CREATE POLICY ops_alert_events_service_policy
  ON public.ops_alert_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 4) public.feature_flag_kill_events (append-only kill-switch ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.feature_flag_kill_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feature_flag_id UUID NOT NULL REFERENCES public.feature_flags(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL,
  reason TEXT NULL,
  prior_enabled BOOLEAN NULL,
  prior_rollout_percentage INTEGER NULL,
  acted_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT feature_flag_kill_events_event_type_ck
    CHECK (event_type IN ('engaged','released','rollout_changed','toggled'))
);

CREATE INDEX IF NOT EXISTS idx_feature_flag_kill_events_flag
  ON public.feature_flag_kill_events (feature_flag_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_feature_flag_kill_events_org
  ON public.feature_flag_kill_events (organization_id, created_at DESC);

COMMENT ON TABLE public.feature_flag_kill_events
  IS 'Append-only audit ledger for feature flag kill-switch and rollout transitions.';

ALTER TABLE public.feature_flag_kill_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.feature_flag_kill_events FROM PUBLIC;
REVOKE ALL ON TABLE public.feature_flag_kill_events FROM anon;
REVOKE ALL ON TABLE public.feature_flag_kill_events FROM authenticated;
GRANT ALL ON TABLE public.feature_flag_kill_events TO service_role;

DROP POLICY IF EXISTS feature_flag_kill_events_service_policy ON public.feature_flag_kill_events;
CREATE POLICY feature_flag_kill_events_service_policy
  ON public.feature_flag_kill_events
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 5) public.capability_grant_requests (request_capability_grant_v1 ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.capability_grant_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  requested_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  target_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  capability_key TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  scope_id UUID NULL,
  reason TEXT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  manual_review_task_id UUID NULL,
  decided_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decided_at TIMESTAMPTZ NULL,
  decision_notes TEXT NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT capability_grant_requests_status_ck
    CHECK (status IN ('pending','approved','denied','cancelled')),
  CONSTRAINT capability_grant_requests_capability_ck
    CHECK (btrim(capability_key) <> ''),
  CONSTRAINT capability_grant_requests_scope_type_ck
    CHECK (scope_type IN ('global','platform','tenant','client','sender','source'))
);

CREATE INDEX IF NOT EXISTS idx_capability_grant_requests_org_status
  ON public.capability_grant_requests (organization_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capability_grant_requests_target
  ON public.capability_grant_requests (target_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_capability_grant_requests_capability
  ON public.capability_grant_requests (capability_key, status, created_at DESC);

COMMENT ON TABLE public.capability_grant_requests
  IS 'Workflow ledger for access_policy.request capability grants. Replaces PREVIEW stub with real backend.';

ALTER TABLE public.capability_grant_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.capability_grant_requests FROM PUBLIC;
REVOKE ALL ON TABLE public.capability_grant_requests FROM anon;
REVOKE ALL ON TABLE public.capability_grant_requests FROM authenticated;
GRANT ALL ON TABLE public.capability_grant_requests TO service_role;

DROP POLICY IF EXISTS capability_grant_requests_service_policy ON public.capability_grant_requests;
CREATE POLICY capability_grant_requests_service_policy
  ON public.capability_grant_requests
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 6) Capability registry: append B1 capabilities to global access_control_policy
--    (alerts.read, alerts.write, feature_flags.read, feature_flags.write,
--     warehouse.read, warehouse.write). Idempotent: only updates when missing.
-------------------------------------------------------------------------------

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
    'alerts.read',
    'alerts.write',
    'feature_flags.read',
    'feature_flags.write',
    'warehouse.read',
    'warehouse.write'
  ];
  v_new_cap TEXT;
  v_new_caps_array JSONB := '[]'::jsonb;
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
  FOR v_idx IN 0 .. jsonb_array_length(v_caps) - 1 LOOP
    v_existing_keys := array_append(v_existing_keys, COALESCE(v_caps->v_idx->>'key', ''));
  END LOOP;

  -- Append any missing target caps
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
    RETURN;
  END IF;

  -- Grant the new caps to ops_admin role (and super_admin already has '*' wildcard)
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

  SELECT COALESCE(MAX(version), 0) + 1
    INTO v_next_version
    FROM public.settings_versions
   WHERE category = 'access_control_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL;

  -- The settings_versions current-row index is one active approved row per
  -- category/scope. Close the previous active access-control policy before
  -- inserting the B1 version so fresh local/shared replays are deterministic.
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
    'B1 platform RPCs: register alerts/feature_flags/warehouse capabilities',
    now()
  );

  -- Refresh settings cache
  INSERT INTO public.settings (category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated)
  SELECT
    sv.category,
    sv.scope_type,
    sv.scope_id,
    sv.scope_hash,
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

SELECT pg_advisory_unlock(hashtext('202604280001_phase_b1_platform_rpcs_foundation_v1'));
COMMIT;
