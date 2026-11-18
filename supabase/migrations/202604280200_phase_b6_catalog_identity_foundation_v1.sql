-- Spec-Issue: Phase B6 - Catalog/Identity canonical RPC foundation
-- Step: B6-Foundation
-- Migration: Foundation tables + capability registry for B6 catalog/identity/cross-cutting RPCs.
-- Purpose:
--   * Register canonical capabilities used by Phase B6 RPCs in the global access_control_policy
--     (agreements.write, lookups.write, mappings.write, webhooks.write, workflows.write).
--   * Add suspension_reason column to public.senders for sender_suspend_v1.
--   * Add column scaffolding to public.lookup_definitions/lookup_values to support draft->published
--     promotion and tenant-scoped extension by lookup_value_promote_v1.
--   * Create supporting append-only ledgers required by B6 RPC contracts:
--       - public.lookup_value_revisions    (audit trail of update/promote/archive flows)
--       - public.mapping_config_revisions  (audit trail of mapping_config_promote_v1)
--       - public.webhook_inbox_replays     (audit trail of webhook_inbox_replay/force_status)
--       - public.revocation_audit          (audit trail of revoke_session_v1; canonical fallback
--                                           for Supabase auth.sessions which is server-managed)
--       - public.workflow_binding_registrations (audit trail of register_workflow_binding_v1)
--       - public.workflow_binding_simulations (audit trail of simulate_binding_dispatch_v1)
--       - public.task_bulk_transition_runs (audit trail of bulk_transition_tasks_v1)
--   * Each ledger has explicit RLS, service_role policy, no anon/authenticated grants.
--
-- Architectural decision (revoke_session_v1):
--   Supabase manages user sessions in auth.sessions (which lives in the auth schema and is
--   not directly mutable by user-defined SECURITY DEFINER functions in production posture).
--   Therefore revoke_session_v1 writes a canonical audit row to public.revocation_audit and
--   exposes correlation_id / decision_log_id so an out-of-band edge function (using the
--   Supabase Admin API) can subsequently invoke auth.admin.signOut(user_id) for the resolved
--   user. The DB RPC is the SSOT for the revocation INTENT; the actual session termination
--   happens via the trusted edge runtime. pgTAP coverage validates the audit-write path.
--
-- Append-only: this migration creates new objects only.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280200_phase_b6_catalog_identity_foundation_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) public.senders: add suspension_reason column for canonical suspend RPC
-------------------------------------------------------------------------------

ALTER TABLE public.senders
  ADD COLUMN IF NOT EXISTS suspension_reason TEXT NULL;

COMMENT ON COLUMN public.senders.suspension_reason
  IS 'Reason captured by sender_suspend_v1; cleared by sender_reactivate_v1.';

-------------------------------------------------------------------------------
-- 2) public.lookup_definitions: tenant-scoping/promotion scaffolding
-------------------------------------------------------------------------------

ALTER TABLE public.lookup_definitions
  ADD COLUMN IF NOT EXISTS organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.lookup_definitions
  ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'global';

ALTER TABLE public.lookup_definitions
  DROP CONSTRAINT IF EXISTS lookup_definitions_scope_type_ck;
ALTER TABLE public.lookup_definitions
  ADD CONSTRAINT lookup_definitions_scope_type_ck
  CHECK (scope_type IN ('global', 'tenant'));

COMMENT ON COLUMN public.lookup_definitions.organization_id
  IS 'NULL when scope_type=global (system definitions). Set when tenant introduces a new lookup category.';
COMMENT ON COLUMN public.lookup_definitions.scope_type
  IS 'global | tenant. Tenant-scoped definitions live alongside global ones; resolvers union the visible set.';

CREATE INDEX IF NOT EXISTS idx_lookup_definitions_scope_org
  ON public.lookup_definitions (scope_type, organization_id, category);

-------------------------------------------------------------------------------
-- 3) public.lookup_values: add organization_id + draft/published support columns
-------------------------------------------------------------------------------

ALTER TABLE public.lookup_values
  ADD COLUMN IF NOT EXISTS organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE;

ALTER TABLE public.lookup_values
  ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ NULL;

ALTER TABLE public.lookup_values
  ADD COLUMN IF NOT EXISTS published_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL;

ALTER TABLE public.lookup_values
  ADD COLUMN IF NOT EXISTS archived_at TIMESTAMPTZ NULL;

ALTER TABLE public.lookup_values
  ADD COLUMN IF NOT EXISTS archived_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_lookup_values_org_status
  ON public.lookup_values (organization_id, status, lookup_definition_id)
  WHERE archived_at IS NULL;

-------------------------------------------------------------------------------
-- 4) public.lookup_value_revisions (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.lookup_value_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lookup_value_id UUID NOT NULL REFERENCES public.lookup_values(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lookup_value_revisions_revision_ck CHECK (revision >= 1),
  CONSTRAINT lookup_value_revisions_action_ck CHECK (
    action IN ('create', 'update', 'archive', 'promote')
  ),
  CONSTRAINT lookup_value_revisions_unique UNIQUE (lookup_value_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_lookup_value_revisions_value
  ON public.lookup_value_revisions (lookup_value_id, revision DESC);
CREATE INDEX IF NOT EXISTS idx_lookup_value_revisions_org
  ON public.lookup_value_revisions (organization_id, created_at DESC);

COMMENT ON TABLE public.lookup_value_revisions
  IS 'Append-only audit trail of lookup_value mutations (create/update/archive/promote).';

ALTER TABLE public.lookup_value_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.lookup_value_revisions FROM PUBLIC;
REVOKE ALL ON TABLE public.lookup_value_revisions FROM anon;
REVOKE ALL ON TABLE public.lookup_value_revisions FROM authenticated;
GRANT ALL ON TABLE public.lookup_value_revisions TO service_role;

DROP POLICY IF EXISTS lookup_value_revisions_service_policy ON public.lookup_value_revisions;
CREATE POLICY lookup_value_revisions_service_policy
  ON public.lookup_value_revisions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 5) public.mapping_config_revisions (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.mapping_config_revisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  mapping_config_id UUID NOT NULL REFERENCES public.mapping_configs(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL,
  promoted_from_version INTEGER NULL,
  promoted_to_version INTEGER NOT NULL,
  before_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  after_value JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT mapping_config_revisions_revision_ck CHECK (revision >= 1),
  CONSTRAINT mapping_config_revisions_promote_ck CHECK (promoted_to_version >= 1),
  CONSTRAINT mapping_config_revisions_unique UNIQUE (mapping_config_id, revision)
);

CREATE INDEX IF NOT EXISTS idx_mapping_config_revisions_config
  ON public.mapping_config_revisions (mapping_config_id, revision DESC);

COMMENT ON TABLE public.mapping_config_revisions
  IS 'Append-only audit trail of mapping_config_promote_v1 version bumps.';

ALTER TABLE public.mapping_config_revisions ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.mapping_config_revisions FROM PUBLIC;
REVOKE ALL ON TABLE public.mapping_config_revisions FROM anon;
REVOKE ALL ON TABLE public.mapping_config_revisions FROM authenticated;
GRANT ALL ON TABLE public.mapping_config_revisions TO service_role;

DROP POLICY IF EXISTS mapping_config_revisions_service_policy ON public.mapping_config_revisions;
CREATE POLICY mapping_config_revisions_service_policy
  ON public.mapping_config_revisions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 6) public.webhook_inbox_replays (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.webhook_inbox_replays (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  webhook_inbox_id UUID NOT NULL REFERENCES public.webhook_inbox(id) ON DELETE CASCADE,
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  webhook_source_id UUID NOT NULL,
  action TEXT NOT NULL,
  prior_status TEXT NULL,
  forced_status TEXT NULL,
  reason TEXT NULL,
  changed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT webhook_inbox_replays_action_ck CHECK (
    action IN ('replay', 'force_status')
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_inbox_replays_inbox
  ON public.webhook_inbox_replays (webhook_inbox_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_webhook_inbox_replays_org
  ON public.webhook_inbox_replays (organization_id, created_at DESC);

COMMENT ON TABLE public.webhook_inbox_replays
  IS 'Append-only audit trail of webhook_inbox_replay_v1 / webhook_inbox_force_status_v1 actions.';

ALTER TABLE public.webhook_inbox_replays ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.webhook_inbox_replays FROM PUBLIC;
REVOKE ALL ON TABLE public.webhook_inbox_replays FROM anon;
REVOKE ALL ON TABLE public.webhook_inbox_replays FROM authenticated;
GRANT ALL ON TABLE public.webhook_inbox_replays TO service_role;

DROP POLICY IF EXISTS webhook_inbox_replays_service_policy ON public.webhook_inbox_replays;
CREATE POLICY webhook_inbox_replays_service_policy
  ON public.webhook_inbox_replays
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 7) public.revocation_audit (append-only audit ledger for session revocation)
--    Architectural decision: Supabase manages auth.sessions; this table captures
--    the canonical revocation INTENT. An out-of-band edge function consumes this
--    ledger and calls auth.admin.signOut(user_id) via the Supabase Admin API.
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.revocation_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  target_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  session_id TEXT NULL,
  reason TEXT NULL,
  revoked_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at TIMESTAMPTZ NULL,
  CONSTRAINT revocation_audit_status_ck CHECK (
    status IN ('pending', 'processing', 'completed', 'failed')
  )
);

CREATE INDEX IF NOT EXISTS idx_revocation_audit_target
  ON public.revocation_audit (target_user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_revocation_audit_status
  ON public.revocation_audit (status, created_at);

COMMENT ON TABLE public.revocation_audit
  IS 'Canonical revocation intent ledger; consumed by out-of-band edge worker that invokes Supabase Admin API auth.admin.signOut.';

ALTER TABLE public.revocation_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.revocation_audit FROM PUBLIC;
REVOKE ALL ON TABLE public.revocation_audit FROM anon;
REVOKE ALL ON TABLE public.revocation_audit FROM authenticated;
GRANT ALL ON TABLE public.revocation_audit TO service_role;

DROP POLICY IF EXISTS revocation_audit_service_policy ON public.revocation_audit;
CREATE POLICY revocation_audit_service_policy
  ON public.revocation_audit
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 8) public.workflow_binding_registrations (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_binding_registrations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  binding_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  workflow_template_id UUID NULL,
  scope_type TEXT NOT NULL,
  scope_id UUID NULL,
  binding_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  changed_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  settings_resolution_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_binding_registrations_scope_ck CHECK (
    scope_type IN ('global', 'tenant', 'client', 'sender')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_registrations_key
  ON public.workflow_binding_registrations (binding_key, stage_key, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_workflow_binding_registrations_scope
  ON public.workflow_binding_registrations (scope_type, scope_id, created_at DESC);

COMMENT ON TABLE public.workflow_binding_registrations
  IS 'Append-only audit trail of register_workflow_binding_v1 mutations against workflow_binding_policy.';

ALTER TABLE public.workflow_binding_registrations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_binding_registrations FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_binding_registrations FROM anon;
REVOKE ALL ON TABLE public.workflow_binding_registrations FROM authenticated;
GRANT ALL ON TABLE public.workflow_binding_registrations TO service_role;

DROP POLICY IF EXISTS workflow_binding_registrations_service_policy ON public.workflow_binding_registrations;
CREATE POLICY workflow_binding_registrations_service_policy
  ON public.workflow_binding_registrations
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 9) public.workflow_binding_simulations (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.workflow_binding_simulations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  binding_key TEXT NOT NULL,
  stage_key TEXT NOT NULL,
  scope_type TEXT NOT NULL,
  scope_id UUID NULL,
  inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  outputs JSONB NOT NULL DEFAULT '{}'::jsonb,
  resolved_template_id UUID NULL,
  triggered_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workflow_binding_simulations_scope_ck CHECK (
    scope_type IN ('global', 'tenant', 'client', 'sender')
  )
);

CREATE INDEX IF NOT EXISTS idx_workflow_binding_simulations_key
  ON public.workflow_binding_simulations (binding_key, stage_key, created_at DESC);

COMMENT ON TABLE public.workflow_binding_simulations
  IS 'Append-only audit of simulate_binding_dispatch_v1 dry-run evaluations (no live workflow side effects).';

ALTER TABLE public.workflow_binding_simulations ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.workflow_binding_simulations FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_binding_simulations FROM anon;
REVOKE ALL ON TABLE public.workflow_binding_simulations FROM authenticated;
GRANT ALL ON TABLE public.workflow_binding_simulations TO service_role;

DROP POLICY IF EXISTS workflow_binding_simulations_service_policy ON public.workflow_binding_simulations;
CREATE POLICY workflow_binding_simulations_service_policy
  ON public.workflow_binding_simulations
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 10) public.task_bulk_transition_runs (append-only audit ledger)
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.task_bulk_transition_runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  to_status TEXT NOT NULL,
  reason TEXT NULL,
  total_count INTEGER NOT NULL DEFAULT 0,
  succeeded_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  failures JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  correlation_id TEXT NULL,
  decision_log_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT task_bulk_transition_runs_total_ck CHECK (total_count >= 0),
  CONSTRAINT task_bulk_transition_runs_counts_ck CHECK (
    succeeded_count + failed_count = total_count
  )
);

CREATE INDEX IF NOT EXISTS idx_task_bulk_transition_runs_org
  ON public.task_bulk_transition_runs (organization_id, created_at DESC);

COMMENT ON TABLE public.task_bulk_transition_runs
  IS 'Append-only audit trail of bulk_transition_tasks_v1 invocations (per-call summary; per-task results live in task_events via transition_task_v1).';

ALTER TABLE public.task_bulk_transition_runs ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.task_bulk_transition_runs FROM PUBLIC;
REVOKE ALL ON TABLE public.task_bulk_transition_runs FROM anon;
REVOKE ALL ON TABLE public.task_bulk_transition_runs FROM authenticated;
GRANT ALL ON TABLE public.task_bulk_transition_runs TO service_role;

DROP POLICY IF EXISTS task_bulk_transition_runs_service_policy ON public.task_bulk_transition_runs;
CREATE POLICY task_bulk_transition_runs_service_policy
  ON public.task_bulk_transition_runs
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 11) Capability registry: append B6 capabilities to global access_control_policy
--     (agreements.write, lookups.write, mappings.write, webhooks.write,
--      workflows.write).
--     Idempotent: only updates when missing. Grants new caps to ops_admin role.
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
    'agreements.write',
    'lookups.write',
    'mappings.write',
    'webhooks.write',
    'workflows.write'
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

  -- Grant the new caps to ops_admin role (super_admin already has '*' wildcard)
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
    'B6 catalog/identity RPCs: register agreements/lookups/mappings/webhooks/workflows write capabilities',
    now()
  );

  -- Refresh settings cache
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

SELECT pg_advisory_unlock(hashtext('202604280200_phase_b6_catalog_identity_foundation_v1'));
COMMIT;
