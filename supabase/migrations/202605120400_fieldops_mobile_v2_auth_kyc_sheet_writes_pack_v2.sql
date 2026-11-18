-- Migration: fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2
-- Date: 2026-05-12
-- Spec: Backend-contract audit P0 — Mobile V2 fieldops second-wave write
--   coverage. Pack v1 (202605120300) shipped 8 stop/trip/COD/wallet write
--   RPCs; this pack adds the 11 remaining auth / KYC / onboarding-gate /
--   sheet-driven writes so every visible action button in V2 lands on
--   canonical tables + decision_log.
--
--   The 11 RPCs (all `public.*` SECURITY DEFINER + `api.*` SECURITY
--   INVOKER mirrors; all VOLATILE; all idempotent via p_idempotency_key):
--
--     1)  submit_fieldops_auth_otp_v1          — verifies OTP and marks the session authenticated
--     2)  submit_fieldops_role_set_v1          — sets the caller's active role for this shift
--     3)  submit_fieldops_kyc_doc_v1           — records a KYC document upload (id/license/iqama)
--     4)  submit_fieldops_kyc_vehicle_v1       — records vehicle registration (plate/vin/year/model/istimara)
--     5)  record_fieldops_cleaning_check_v1    — records a cleaning attestation with checked items + photo
--     6)  pass_fieldops_pre_shift_gate_v1      — clears the pre-shift gate (blockers + health attestation)
--     7)  submit_fieldops_incident_v1          — files an incident (collision/theft/breakdown/complaint)
--     8)  submit_fieldops_reassign_v1          — reassigns a stop to another driver
--     9)  submit_fieldops_reschedule_v1        — moves a stop's promised window
--     10) submit_fieldops_damage_hold_v1       — flags a parcel into the hold queue
--     11) submit_fieldops_eod_recon_v1         — submits EOD reconciliation (parcels/cash/wallet)
--
-- AGENTS.md compliance posture:
-- - RLS: ships five new tenant-scoped tables (`public.fieldops_user_roles`,
--   `public.fieldops_v2_kyc_docs`, `public.fieldops_v2_vehicles`,
--   `public.fieldops_v2_cleaning_checks`, `public.fieldops_v2_pre_shift_passes`,
--   `public.fieldops_v2_incidents`, `public.shipment_holds`) with RLS
--   enabled + service_role policy + org-scoped select policy + user-can-
--   write insert policy (matches the existing `fieldops_v2_inductions`
--   posture in pack v1).
-- - Idempotency: every write short-circuits on prior decision_log entry
--   keyed by p_idempotency_key (re-returns the same decision_log_id)
--   using public.fieldops_v2_existing_decision_v1(...).
-- - Decision_log: every successful state transition writes a row via the
--   canonical `public.log_decision(...)` helper.
-- - Scope ladder: callers must be authenticated (`auth.uid()`); writes
--   that require tenant context additionally require
--   `current_user_org_id()` and raise 42501 when missing. The auth-OTP
--   RPC is the single exception: it only requires auth.uid() because the
--   session is in the act of being authenticated and the org may not yet
--   be resolvable.
-- - Zero hardcoding: valid doc-keys / severities / wallet statuses /
--   incident severities mirror the FE allow-lists exactly; no tenant /
--   environment constants.
-- - Single source of truth: all api.* wrappers proxy to public.* so
--   PostgREST sees one shape per RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120400_fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ===========================================================================
-- 0a) Companion tables (tenant-scoped + RLS-enabled).
--     Each table follows the fieldops_v2_inductions posture from pack v1:
--       - REVOKE all from PUBLIC/anon/authenticated
--       - GRANT SELECT, INSERT to authenticated
--       - GRANT ALL to service_role
--       - service_role ALL policy + org-scoped SELECT policy + user-write
--         INSERT policy guarded by public.user_can_write()
-- ===========================================================================

-- Active role assignments for the caller (one row per (user, role)).
CREATE TABLE IF NOT EXISTS public.fieldops_user_roles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  role_id TEXT NOT NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_user_roles_role_ck CHECK (btrim(role_id) <> ''),
  CONSTRAINT fieldops_user_roles_unique UNIQUE (organization_id, user_id, role_id)
);

CREATE INDEX IF NOT EXISTS idx_fieldops_user_roles_active
  ON public.fieldops_user_roles (organization_id, user_id, is_active);

COMMENT ON TABLE public.fieldops_user_roles IS
  'Mobile V2 active role assignments per (org, user, role). is_active=TRUE marks the currently-shift role chosen via the role-select screen.';

ALTER TABLE public.fieldops_user_roles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_user_roles FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_user_roles FROM anon;
REVOKE ALL ON TABLE public.fieldops_user_roles FROM authenticated;
GRANT SELECT, INSERT, UPDATE ON TABLE public.fieldops_user_roles TO authenticated;
GRANT ALL ON TABLE public.fieldops_user_roles TO service_role;

DROP POLICY IF EXISTS fieldops_user_roles_service_policy ON public.fieldops_user_roles;
CREATE POLICY fieldops_user_roles_service_policy ON public.fieldops_user_roles
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_user_roles_select_policy ON public.fieldops_user_roles;
CREATE POLICY fieldops_user_roles_select_policy ON public.fieldops_user_roles
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_user_roles_insert_policy ON public.fieldops_user_roles;
CREATE POLICY fieldops_user_roles_insert_policy ON public.fieldops_user_roles
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_user_roles_update_policy ON public.fieldops_user_roles;
CREATE POLICY fieldops_user_roles_update_policy ON public.fieldops_user_roles
  FOR UPDATE TO authenticated
  USING (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  )
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- KYC documents.
CREATE TABLE IF NOT EXISTS public.fieldops_v2_kyc_docs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  doc_key TEXT NOT NULL,
  storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'uploaded',
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_kyc_docs_key_ck
    CHECK (doc_key IN ('idDoc', 'licenseDoc', 'iqamaDoc')),
  CONSTRAINT fieldops_v2_kyc_docs_storage_ck CHECK (btrim(storage_path) <> ''),
  CONSTRAINT fieldops_v2_kyc_docs_status_ck
    CHECK (status IN ('uploaded', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_kyc_docs_user_created
  ON public.fieldops_v2_kyc_docs (organization_id, user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_kyc_docs IS
  'Mobile V2 KYC document uploads. Each row is one upload event of (idDoc|licenseDoc|iqamaDoc) for a user inside an org. Verifier flips status to approved/rejected.';

ALTER TABLE public.fieldops_v2_kyc_docs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_kyc_docs FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_kyc_docs FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_kyc_docs FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.fieldops_v2_kyc_docs TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_kyc_docs TO service_role;

DROP POLICY IF EXISTS fieldops_v2_kyc_docs_service_policy ON public.fieldops_v2_kyc_docs;
CREATE POLICY fieldops_v2_kyc_docs_service_policy ON public.fieldops_v2_kyc_docs
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_kyc_docs_select_policy ON public.fieldops_v2_kyc_docs;
CREATE POLICY fieldops_v2_kyc_docs_select_policy ON public.fieldops_v2_kyc_docs
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND (user_id = auth.uid() OR public.user_can_write())
    )
  );

DROP POLICY IF EXISTS fieldops_v2_kyc_docs_insert_policy ON public.fieldops_v2_kyc_docs;
CREATE POLICY fieldops_v2_kyc_docs_insert_policy ON public.fieldops_v2_kyc_docs
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- KYC vehicle registrations.
CREATE TABLE IF NOT EXISTS public.fieldops_v2_vehicles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  plate TEXT NOT NULL,
  vin TEXT NOT NULL,
  year TEXT NOT NULL,
  model TEXT NOT NULL,
  istimara_storage_path TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'submitted',
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_vehicles_plate_ck CHECK (length(btrim(plate)) >= 5),
  CONSTRAINT fieldops_v2_vehicles_vin_ck CHECK (length(btrim(vin)) >= 8),
  CONSTRAINT fieldops_v2_vehicles_year_ck CHECK (btrim(year) ~ '^[0-9]{4}$'),
  CONSTRAINT fieldops_v2_vehicles_model_ck CHECK (btrim(model) <> ''),
  CONSTRAINT fieldops_v2_vehicles_istimara_ck CHECK (btrim(istimara_storage_path) <> ''),
  CONSTRAINT fieldops_v2_vehicles_status_ck
    CHECK (status IN ('submitted', 'approved', 'rejected'))
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_vehicles_user
  ON public.fieldops_v2_vehicles (organization_id, user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_vehicles IS
  'Mobile V2 vehicle registration submissions captured during KYC step 2. One row per submission; verifier updates status.';

ALTER TABLE public.fieldops_v2_vehicles ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_vehicles FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_vehicles FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_vehicles FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.fieldops_v2_vehicles TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_vehicles TO service_role;

DROP POLICY IF EXISTS fieldops_v2_vehicles_service_policy ON public.fieldops_v2_vehicles;
CREATE POLICY fieldops_v2_vehicles_service_policy ON public.fieldops_v2_vehicles
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_vehicles_select_policy ON public.fieldops_v2_vehicles;
CREATE POLICY fieldops_v2_vehicles_select_policy ON public.fieldops_v2_vehicles
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND (user_id = auth.uid() OR public.user_can_write())
    )
  );

DROP POLICY IF EXISTS fieldops_v2_vehicles_insert_policy ON public.fieldops_v2_vehicles;
CREATE POLICY fieldops_v2_vehicles_insert_policy ON public.fieldops_v2_vehicles
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- Daily cleaning attestations.
CREATE TABLE IF NOT EXISTS public.fieldops_v2_cleaning_checks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  checked_item_ids TEXT[] NOT NULL,
  photo_storage_path TEXT NOT NULL,
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_cleaning_items_ck CHECK (array_length(checked_item_ids, 1) >= 1),
  CONSTRAINT fieldops_v2_cleaning_photo_ck CHECK (btrim(photo_storage_path) <> '')
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_cleaning_user
  ON public.fieldops_v2_cleaning_checks (organization_id, user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_cleaning_checks IS
  'Mobile V2 daily cleaning attestations captured before route start. Linked to decision_log for audit + cold-chain readiness.';

ALTER TABLE public.fieldops_v2_cleaning_checks ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_cleaning_checks FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_cleaning_checks FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_cleaning_checks FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.fieldops_v2_cleaning_checks TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_cleaning_checks TO service_role;

DROP POLICY IF EXISTS fieldops_v2_cleaning_checks_service_policy ON public.fieldops_v2_cleaning_checks;
CREATE POLICY fieldops_v2_cleaning_checks_service_policy ON public.fieldops_v2_cleaning_checks
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_cleaning_checks_select_policy ON public.fieldops_v2_cleaning_checks;
CREATE POLICY fieldops_v2_cleaning_checks_select_policy ON public.fieldops_v2_cleaning_checks
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_v2_cleaning_checks_insert_policy ON public.fieldops_v2_cleaning_checks;
CREATE POLICY fieldops_v2_cleaning_checks_insert_policy ON public.fieldops_v2_cleaning_checks
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- Pre-shift gate passes.
CREATE TABLE IF NOT EXISTS public.fieldops_v2_pre_shift_passes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  shift_id TEXT NOT NULL,
  health_ok BOOLEAN NOT NULL,
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_pre_shift_shift_ck CHECK (btrim(shift_id) <> '')
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_pre_shift_user
  ON public.fieldops_v2_pre_shift_passes (organization_id, user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_pre_shift_passes IS
  'Mobile V2 pre-shift gate clearances. One row per (user, shift_id) pass. Health attestation captured here so dispatch can audit fitness-to-drive.';

ALTER TABLE public.fieldops_v2_pre_shift_passes ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_pre_shift_passes FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_pre_shift_passes FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_pre_shift_passes FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.fieldops_v2_pre_shift_passes TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_pre_shift_passes TO service_role;

DROP POLICY IF EXISTS fieldops_v2_pre_shift_passes_service_policy ON public.fieldops_v2_pre_shift_passes;
CREATE POLICY fieldops_v2_pre_shift_passes_service_policy ON public.fieldops_v2_pre_shift_passes
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_pre_shift_passes_select_policy ON public.fieldops_v2_pre_shift_passes;
CREATE POLICY fieldops_v2_pre_shift_passes_select_policy ON public.fieldops_v2_pre_shift_passes
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_v2_pre_shift_passes_insert_policy ON public.fieldops_v2_pre_shift_passes;
CREATE POLICY fieldops_v2_pre_shift_passes_insert_policy ON public.fieldops_v2_pre_shift_passes
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- Incidents.
CREATE TABLE IF NOT EXISTS public.fieldops_v2_incidents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  reported_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  stop_id UUID NULL,
  type_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  statement TEXT NULL,
  photo_storage_path TEXT NULL,
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_incidents_type_ck CHECK (btrim(type_id) <> ''),
  CONSTRAINT fieldops_v2_incidents_severity_ck
    CHECK (severity IN ('high', 'med', 'low'))
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_incidents_org_created
  ON public.fieldops_v2_incidents (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_incidents_user_created
  ON public.fieldops_v2_incidents (organization_id, reported_by_user_id, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_incidents IS
  'Mobile V2 incident reports (collision/theft/breakdown/complaint). Severity drives downstream dispatch + insurance routing.';

ALTER TABLE public.fieldops_v2_incidents ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_incidents FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_incidents FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_incidents FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.fieldops_v2_incidents TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_incidents TO service_role;

DROP POLICY IF EXISTS fieldops_v2_incidents_service_policy ON public.fieldops_v2_incidents;
CREATE POLICY fieldops_v2_incidents_service_policy ON public.fieldops_v2_incidents
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_incidents_select_policy ON public.fieldops_v2_incidents;
CREATE POLICY fieldops_v2_incidents_select_policy ON public.fieldops_v2_incidents
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_v2_incidents_insert_policy ON public.fieldops_v2_incidents;
CREATE POLICY fieldops_v2_incidents_insert_policy ON public.fieldops_v2_incidents
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- Damage hold queue. (No prior shipment_holds table exists; this one is new.)
CREATE TABLE IF NOT EXISTS public.shipment_holds (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  parcel_id UUID NOT NULL,
  reported_by_user_id UUID NOT NULL REFERENCES public.users(id) ON DELETE CASCADE,
  severity_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NULL,
  photo_storage_path TEXT NULL,
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ NULL,
  CONSTRAINT shipment_holds_severity_ck CHECK (btrim(severity_id) <> ''),
  CONSTRAINT shipment_holds_status_ck
    CHECK (status IN ('open', 'resolved', 'discarded', 'escalated'))
);

CREATE INDEX IF NOT EXISTS idx_shipment_holds_org_created
  ON public.shipment_holds (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_shipment_holds_status
  ON public.shipment_holds (organization_id, status, created_at DESC);

COMMENT ON TABLE public.shipment_holds IS
  'Hold queue rows for parcels quarantined via the damage-hold sheet. Linked to decision_log for audit + supervisor sign-off.';

ALTER TABLE public.shipment_holds ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.shipment_holds FROM PUBLIC;
REVOKE ALL ON TABLE public.shipment_holds FROM anon;
REVOKE ALL ON TABLE public.shipment_holds FROM authenticated;
GRANT SELECT, INSERT ON TABLE public.shipment_holds TO authenticated;
GRANT ALL ON TABLE public.shipment_holds TO service_role;

DROP POLICY IF EXISTS shipment_holds_service_policy ON public.shipment_holds;
CREATE POLICY shipment_holds_service_policy ON public.shipment_holds
  FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE);

DROP POLICY IF EXISTS shipment_holds_select_policy ON public.shipment_holds;
CREATE POLICY shipment_holds_select_policy ON public.shipment_holds
  FOR SELECT TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS shipment_holds_insert_policy ON public.shipment_holds;
CREATE POLICY shipment_holds_insert_policy ON public.shipment_holds
  FOR INSERT TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- ===========================================================================
-- 1) submit_fieldops_auth_otp_v1 — verifies OTP, marks user authenticated.
--    This is the ONLY RPC in the pack that does NOT require an org context
--    because the session is in the act of being authenticated. We accept
--    any 6-digit OTP for now because the OTP provider is not wired.
--    TODO: provider-verify — swap the format check for the canonical
--    `verify_otp_v1(employee_id, otp)` policy call when the OTP provider
--    is connected.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_auth_otp_v1(
  p_employee_id TEXT,
  p_otp TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_employee   TEXT := NULLIF(btrim(COALESCE(p_employee_id, '')), '');
  v_otp        TEXT := NULLIF(btrim(COALESCE(p_otp, '')), '');
  v_org        UUID;
  v_existing   UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_auth_otp_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_auth_otp_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_employee IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_auth_otp_v1 requires employee_id' USING ERRCODE = '22023';
  END IF;
  -- TODO: provider-verify — for now require 6-digit numeric OTP.
  IF v_otp IS NULL OR v_otp !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'submit_fieldops_auth_otp_v1: otp must be 6 digits' USING ERRCODE = '22023';
  END IF;

  -- Best-effort org context (NULL when called pre-membership).
  v_org := public.current_user_org_id();

  -- Idempotency replay (only when org is resolved; pre-org auth replays
  -- always run through but emit a fresh decision_log entry).
  IF v_org IS NOT NULL THEN
    v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_auth_otp', p_idempotency_key);
    IF v_existing IS NOT NULL THEN
      RETURN jsonb_build_object(
        'decision_log_id', v_existing,
        'ok', TRUE,
        'state', 'replayed',
        'employee_id', v_employee
      );
    END IF;
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_auth_otp',
    p_resource_type       := 'auth_session',
    p_resource_id         := v_user_id,
    p_decision_point      := 'verify_otp',
    p_decision_outcome    := 'authenticated',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'employee_id',  v_employee,
                               'otp_present',  TRUE,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'authenticated',
    'employee_id', v_employee
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_auth_otp_v1(TEXT, TEXT, UUID) IS
  'Mobile V2 login OTP verify write. Validates OTP format (6 digits) only — provider verification is a TODO. Idempotent on p_idempotency_key when org context is resolved.';

REVOKE ALL ON FUNCTION public.submit_fieldops_auth_otp_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_auth_otp_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_auth_otp_v1(
  p_employee_id TEXT,
  p_otp TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_auth_otp_v1(p_employee_id, p_otp, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_auth_otp_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_auth_otp_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 2) submit_fieldops_role_set_v1 — set the caller's active role.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_role_set_v1(
  p_role_id TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id    UUID := auth.uid();
  v_org        UUID;
  v_role       TEXT := NULLIF(btrim(COALESCE(p_role_id, '')), '');
  v_existing   UUID;
  v_decision_id UUID;
  v_role_row_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_role_set_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_role_set_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_role_set_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_role IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_role_set_v1 requires role_id' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_role_set', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'role_id', v_role
    );
  END IF;

  -- Deactivate any other active roles for this user/org, then upsert the new
  -- one as active. UNIQUE (organization_id, user_id, role_id) keeps history
  -- per role unique while still letting the same user re-toggle roles.
  UPDATE public.fieldops_user_roles
     SET is_active = FALSE,
         updated_at = now()
   WHERE organization_id = v_org
     AND user_id = v_user_id
     AND is_active = TRUE
     AND role_id <> v_role;

  INSERT INTO public.fieldops_user_roles (organization_id, user_id, role_id, is_active, metadata)
  VALUES (v_org, v_user_id, v_role, TRUE,
          jsonb_build_object('correlation_id', p_idempotency_key))
  ON CONFLICT (organization_id, user_id, role_id) DO UPDATE
    SET is_active = TRUE,
        updated_at = now(),
        metadata = jsonb_set(
                     COALESCE(public.fieldops_user_roles.metadata, '{}'::jsonb),
                     '{correlation_id}',
                     to_jsonb(p_idempotency_key::text),
                     TRUE
                   )
  RETURNING id INTO v_role_row_id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_role_set',
    p_resource_type       := 'fieldops_user_role',
    p_resource_id         := v_role_row_id,
    p_decision_point      := 'set_active_role',
    p_decision_outcome    := v_role,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'role_id',       v_role,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'active',
    'role_id', v_role,
    'role_row_id', v_role_row_id
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_role_set_v1(TEXT, UUID) IS
  'Mobile V2 role-select write. Deactivates other active roles for (org, user), then upserts the chosen role as active. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_role_set_v1(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_role_set_v1(TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_role_set_v1(
  p_role_id TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_role_set_v1(p_role_id, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_role_set_v1(TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_role_set_v1(TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 3) submit_fieldops_kyc_doc_v1 — record a KYC doc upload.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_kyc_doc_v1(
  p_doc_key TEXT,
  p_storage_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_key         TEXT := NULLIF(btrim(COALESCE(p_doc_key, '')), '');
  v_path        TEXT := NULLIF(btrim(COALESCE(p_storage_path, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_doc_id      UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_doc_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_doc_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_doc_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_key IS NULL OR v_key NOT IN ('idDoc', 'licenseDoc', 'iqamaDoc') THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_doc_v1: invalid doc_key %', p_doc_key USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_doc_v1 requires storage_path' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_kyc_doc', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'doc_key', v_key
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_kyc_doc',
    p_resource_type       := 'fieldops_v2_kyc_doc',
    p_resource_id         := v_doc_id,
    p_decision_point      := 'submit_kyc_doc',
    p_decision_outcome    := 'uploaded',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'doc_key',       v_key,
                               'storage_path',  v_path,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_kyc_docs (
    id, organization_id, user_id, doc_key, storage_path, status, decision_log_id, metadata
  ) VALUES (
    v_doc_id, v_org, v_user_id, v_key, v_path, 'uploaded', v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'uploaded',
    'doc_id', v_doc_id,
    'doc_key', v_key
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_kyc_doc_v1(TEXT, TEXT, UUID) IS
  'Mobile V2 KYC document upload write. Validates doc_key in {idDoc,licenseDoc,iqamaDoc} + non-empty storage_path. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_kyc_doc_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_kyc_doc_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_kyc_doc_v1(
  p_doc_key TEXT,
  p_storage_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_kyc_doc_v1(p_doc_key, p_storage_path, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_kyc_doc_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_kyc_doc_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 4) submit_fieldops_kyc_vehicle_v1 — record vehicle registration.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_kyc_vehicle_v1(
  p_plate TEXT,
  p_vin TEXT,
  p_year TEXT,
  p_model TEXT,
  p_istimara_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_plate       TEXT := NULLIF(btrim(COALESCE(p_plate, '')), '');
  v_vin         TEXT := NULLIF(btrim(COALESCE(p_vin, '')), '');
  v_year        TEXT := NULLIF(btrim(COALESCE(p_year, '')), '');
  v_model       TEXT := NULLIF(btrim(COALESCE(p_model, '')), '');
  v_path        TEXT := NULLIF(btrim(COALESCE(p_istimara_path, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_vehicle_id  UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_plate IS NULL OR length(v_plate) < 5 THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1: plate must be at least 5 chars' USING ERRCODE = '22023';
  END IF;
  IF v_vin IS NULL OR length(v_vin) < 8 THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1: vin must be at least 8 chars' USING ERRCODE = '22023';
  END IF;
  IF v_year IS NULL OR v_year !~ '^[0-9]{4}$' THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1: year must be 4 digits' USING ERRCODE = '22023';
  END IF;
  IF v_model IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1 requires model' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_kyc_vehicle_v1 requires istimara_path' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_kyc_vehicle', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'plate', v_plate
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_kyc_vehicle',
    p_resource_type       := 'fieldops_v2_vehicle',
    p_resource_id         := v_vehicle_id,
    p_decision_point      := 'submit_kyc_vehicle',
    p_decision_outcome    := 'submitted',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'plate',          v_plate,
                               'vin',            v_vin,
                               'year',           v_year,
                               'model',          v_model,
                               'istimara_path',  v_path,
                               'actor_user_id',  v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_vehicles (
    id, organization_id, user_id, plate, vin, year, model,
    istimara_storage_path, status, decision_log_id, metadata
  ) VALUES (
    v_vehicle_id, v_org, v_user_id, v_plate, v_vin, v_year, v_model,
    v_path, 'submitted', v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'submitted',
    'vehicle_id', v_vehicle_id,
    'plate', v_plate
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_kyc_vehicle_v1(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) IS
  'Mobile V2 vehicle registration write. Validates plate>=5, vin>=8, year=4 digits, model non-empty, istimara_path non-empty. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_kyc_vehicle_v1(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_kyc_vehicle_v1(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_kyc_vehicle_v1(
  p_plate TEXT,
  p_vin TEXT,
  p_year TEXT,
  p_model TEXT,
  p_istimara_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_kyc_vehicle_v1(p_plate, p_vin, p_year, p_model, p_istimara_path, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_kyc_vehicle_v1(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_kyc_vehicle_v1(TEXT, TEXT, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 5) record_fieldops_cleaning_check_v1 — daily cleaning attestation.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.record_fieldops_cleaning_check_v1(
  p_checked_ids TEXT[],
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_path        TEXT := NULLIF(btrim(COALESCE(p_photo_path, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_check_id    UUID := gen_random_uuid();
  v_count       INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_checked_ids IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires checked_ids' USING ERRCODE = '22023';
  END IF;
  v_count := COALESCE(array_length(p_checked_ids, 1), 0);
  IF v_count < 1 THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1: checked_ids must contain at least 1 item' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'record_fieldops_cleaning_check_v1 requires photo_path' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_cleaning_check', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'item_count', v_count
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_cleaning_check',
    p_resource_type       := 'fieldops_v2_cleaning_check',
    p_resource_id         := v_check_id,
    p_decision_point      := 'record_cleaning',
    p_decision_outcome    := 'attested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'checked_ids',   to_jsonb(p_checked_ids),
                               'item_count',    v_count,
                               'photo_path',    v_path,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_cleaning_checks (
    id, organization_id, user_id, checked_item_ids, photo_storage_path,
    decision_log_id, metadata
  ) VALUES (
    v_check_id, v_org, v_user_id, p_checked_ids, v_path, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'attested',
    'check_id', v_check_id,
    'item_count', v_count
  );
END;
$$;

COMMENT ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) IS
  'Mobile V2 daily cleaning attestation write. Requires >=1 checked item and a non-empty photo_path. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.record_fieldops_cleaning_check_v1(
  p_checked_ids TEXT[],
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.record_fieldops_cleaning_check_v1(p_checked_ids, p_photo_path, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.record_fieldops_cleaning_check_v1(TEXT[], TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 6) pass_fieldops_pre_shift_gate_v1 — clear the pre-shift gate.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.pass_fieldops_pre_shift_gate_v1(
  p_shift_id TEXT,
  p_health_ok BOOLEAN,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_shift       TEXT := NULLIF(btrim(COALESCE(p_shift_id, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_pass_id     UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_shift IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires shift_id' USING ERRCODE = '22023';
  END IF;
  IF p_health_ok IS NULL THEN
    RAISE EXCEPTION 'pass_fieldops_pre_shift_gate_v1 requires health_ok' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_pre_shift_gate', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'shift_id', v_shift
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_pre_shift_gate',
    p_resource_type       := 'fieldops_v2_pre_shift_pass',
    p_resource_id         := v_pass_id,
    p_decision_point      := 'pass_pre_shift',
    p_decision_outcome    := CASE WHEN p_health_ok THEN 'cleared' ELSE 'cleared_no_health' END,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'shift_id',      v_shift,
                               'health_ok',     p_health_ok,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_pre_shift_passes (
    id, organization_id, user_id, shift_id, health_ok, decision_log_id, metadata
  ) VALUES (
    v_pass_id, v_org, v_user_id, v_shift, p_health_ok, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'cleared',
    'pass_id', v_pass_id,
    'shift_id', v_shift,
    'health_ok', p_health_ok
  );
END;
$$;

COMMENT ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) IS
  'Mobile V2 pre-shift gate clearance write. Captures shift_id + health attestation; idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.pass_fieldops_pre_shift_gate_v1(
  p_shift_id TEXT,
  p_health_ok BOOLEAN,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.pass_fieldops_pre_shift_gate_v1(p_shift_id, p_health_ok, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 7) submit_fieldops_incident_v1 — file an incident.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_incident_v1(
  p_type_id TEXT,
  p_stop_id UUID,
  p_severity TEXT,
  p_statement TEXT,
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_type        TEXT := NULLIF(btrim(COALESCE(p_type_id, '')), '');
  v_severity    TEXT := lower(btrim(COALESCE(p_severity, '')));
  v_statement   TEXT := NULLIF(btrim(COALESCE(p_statement, '')), '');
  v_path        TEXT := NULLIF(btrim(COALESCE(p_photo_path, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_incident_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_incident_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_incident_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_incident_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_type IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_incident_v1 requires type_id' USING ERRCODE = '22023';
  END IF;
  IF v_severity NOT IN ('high', 'med', 'low') THEN
    RAISE EXCEPTION 'submit_fieldops_incident_v1: invalid severity %', p_severity USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_incident', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'type_id', v_type
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_incident',
    p_resource_type       := 'fieldops_v2_incident',
    p_resource_id         := v_incident_id,
    p_decision_point      := 'submit_incident',
    p_decision_outcome    := v_severity,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'type_id',       v_type,
                               'severity',      v_severity,
                               'stop_id',       p_stop_id,
                               'statement',     v_statement,
                               'photo_path',    v_path,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := v_statement,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_incidents (
    id, organization_id, reported_by_user_id, stop_id, type_id, severity,
    statement, photo_storage_path, decision_log_id, metadata
  ) VALUES (
    v_incident_id, v_org, v_user_id, p_stop_id, v_type, v_severity,
    v_statement, v_path, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_severity,
    'incident_id', v_incident_id,
    'type_id', v_type
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_incident_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) IS
  'Mobile V2 incident filing write. Validates severity in {high,med,low}; type_id is open-vocabulary policy-resolved upstream. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_incident_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_incident_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_incident_v1(
  p_type_id TEXT,
  p_stop_id UUID,
  p_severity TEXT,
  p_statement TEXT,
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_incident_v1(p_type_id, p_stop_id, p_severity, p_statement, p_photo_path, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_incident_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_incident_v1(TEXT, UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 8) submit_fieldops_reassign_v1 — reassign a stop to another driver.
--    Note: public.shipments has no driver_id column today (see
--    202510110006_domain_tables_partitioned.sql). Per spec we
--    decision-log + return success; the canonical reassignment surface
--    landing on shipments lives in the dispatch worktree.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_reassign_v1(
  p_stop_id UUID,
  p_target_driver_id UUID,
  p_reason TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_reason      TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_target_driver_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires target_driver_id' USING ERRCODE = '22023';
  END IF;
  IF v_reason IS NULL OR length(v_reason) < 3 THEN
    RAISE EXCEPTION 'submit_fieldops_reassign_v1 requires a reason of at least 3 chars' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_reassign', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_reassign',
    p_resource_type       := 'route_stop',
    p_resource_id         := p_stop_id,
    p_decision_point      := 'reassign_stop',
    p_decision_outcome    := 'requested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'stop_id',           p_stop_id,
                               'target_driver_id',  p_target_driver_id,
                               'reason',            v_reason,
                               'actor_user_id',     v_user_id
                             )),
    p_decision_reason     := v_reason,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'requested',
    'stop_id', p_stop_id,
    'target_driver_id', p_target_driver_id
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) IS
  'Mobile V2 stop-reassignment request write. Requires a non-trivial reason; idempotent on p_idempotency_key. Decision-log only — canonical reassignment lands in dispatch surface.';

REVOKE ALL ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_reassign_v1(
  p_stop_id UUID,
  p_target_driver_id UUID,
  p_reason TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_reassign_v1(p_stop_id, p_target_driver_id, p_reason, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_reassign_v1(UUID, UUID, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 9) submit_fieldops_reschedule_v1 — move a stop's promised window.
--    Note: public.shipments has no promised_window_start/_end columns,
--    so we decision-log + best-effort update the matching public.route_stops
--    planned_window_start_at/end_at when a stop is found within the
--    caller's org (cross-tenant scope check on the stop is mandatory).
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_reschedule_v1(
  p_stop_id UUID,
  p_window_start TIMESTAMPTZ,
  p_window_end TIMESTAMPTZ,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_note        TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_stop        public.route_stops%ROWTYPE;
  v_stop_found  BOOLEAN := FALSE;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_window_start IS NULL OR p_window_end IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1 requires window_start and window_end' USING ERRCODE = '22023';
  END IF;
  IF p_window_end <= p_window_start THEN
    RAISE EXCEPTION 'submit_fieldops_reschedule_v1: window_end must be after window_start' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_reschedule', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  -- Best-effort: if the stop exists in caller's org, update its planned
  -- window. Otherwise we still decision-log so dispatch can correlate.
  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_stop_id FOR UPDATE;
  IF FOUND THEN
    IF v_stop.organization_id IS DISTINCT FROM v_org THEN
      RAISE EXCEPTION 'submit_fieldops_reschedule_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
    END IF;
    v_stop_found := TRUE;
    UPDATE public.route_stops
       SET planned_window_start_at = p_window_start,
           planned_window_end_at   = p_window_end,
           updated_at              = now()
     WHERE id = v_stop.id;
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_reschedule',
    p_resource_type       := 'route_stop',
    p_resource_id         := p_stop_id,
    p_decision_point      := 'reschedule_stop',
    p_decision_outcome    := CASE WHEN v_stop_found THEN 'rescheduled' ELSE 'requested' END,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'stop_id',       p_stop_id,
                               'window_start',  p_window_start,
                               'window_end',    p_window_end,
                               'note',          v_note,
                               'stop_found',    v_stop_found,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := v_note,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', CASE WHEN v_stop_found THEN 'rescheduled' ELSE 'requested' END,
    'stop_id', p_stop_id,
    'stop_found', v_stop_found
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_reschedule_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) IS
  'Mobile V2 stop-reschedule write. Updates route_stops planned_window_*_at when the stop exists in caller org. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_reschedule_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_reschedule_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_reschedule_v1(
  p_stop_id UUID,
  p_window_start TIMESTAMPTZ,
  p_window_end TIMESTAMPTZ,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_reschedule_v1(p_stop_id, p_window_start, p_window_end, p_note, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_reschedule_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_reschedule_v1(UUID, TIMESTAMPTZ, TIMESTAMPTZ, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 10) submit_fieldops_damage_hold_v1 — flag a parcel into the hold queue.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_damage_hold_v1(
  p_parcel_id UUID,
  p_severity_id TEXT,
  p_note TEXT,
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_severity    TEXT := NULLIF(btrim(COALESCE(p_severity_id, '')), '');
  v_note        TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_path        TEXT := NULLIF(btrim(COALESCE(p_photo_path, '')), '');
  v_existing    UUID;
  v_decision_id UUID;
  v_hold_id     UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_parcel_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires parcel_id' USING ERRCODE = '22023';
  END IF;
  IF v_severity IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires severity_id' USING ERRCODE = '22023';
  END IF;
  IF v_note IS NULL OR length(v_note) < 3 THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires a note of at least 3 chars' USING ERRCODE = '22023';
  END IF;
  IF v_path IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_damage_hold_v1 requires photo_path' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_damage_hold', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'parcel_id', p_parcel_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_damage_hold',
    p_resource_type       := 'shipment_hold',
    p_resource_id         := v_hold_id,
    p_decision_point      := 'flag_damage_hold',
    p_decision_outcome    := 'open',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'parcel_id',     p_parcel_id,
                               'severity_id',   v_severity,
                               'note',          v_note,
                               'photo_path',    v_path,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := v_note,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.shipment_holds (
    id, organization_id, parcel_id, reported_by_user_id, severity_id,
    status, note, photo_storage_path, decision_log_id, metadata
  ) VALUES (
    v_hold_id, v_org, p_parcel_id, v_user_id, v_severity,
    'open', v_note, v_path, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'open',
    'hold_id', v_hold_id,
    'parcel_id', p_parcel_id
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_damage_hold_v1(UUID, TEXT, TEXT, TEXT, UUID) IS
  'Mobile V2 damage-hold write. Quarantines a parcel into the hold queue with severity_id, non-trivial note, and photo_path. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_damage_hold_v1(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_damage_hold_v1(UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_damage_hold_v1(
  p_parcel_id UUID,
  p_severity_id TEXT,
  p_note TEXT,
  p_photo_path TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_damage_hold_v1(p_parcel_id, p_severity_id, p_note, p_photo_path, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_damage_hold_v1(UUID, TEXT, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_damage_hold_v1(UUID, TEXT, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 11) submit_fieldops_eod_recon_v1 — submit EOD reconciliation.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_eod_recon_v1(
  p_parcels_count INT,
  p_mismatch_count INT,
  p_cash_declared NUMERIC,
  p_cash_counted NUMERIC,
  p_wallet_status TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id     UUID := auth.uid();
  v_org         UUID;
  v_wallet      TEXT := lower(btrim(COALESCE(p_wallet_status, '')));
  v_existing    UUID;
  v_decision_id UUID;
  v_recon_id    UUID := gen_random_uuid();
  v_variance    NUMERIC;
  v_outcome     TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_parcels_count IS NULL OR p_parcels_count < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: parcels_count must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_mismatch_count IS NULL OR p_mismatch_count < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: mismatch_count must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_cash_declared IS NULL OR p_cash_declared < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: cash_declared must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_cash_counted IS NULL OR p_cash_counted < 0 THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: cash_counted must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF v_wallet NOT IN ('synced', 'stale', 'offline') THEN
    RAISE EXCEPTION 'submit_fieldops_eod_recon_v1: invalid wallet_status %', p_wallet_status USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_eod_recon', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed'
    );
  END IF;

  v_variance := p_cash_counted - p_cash_declared;
  v_outcome  := CASE
                  WHEN p_mismatch_count = 0 AND v_variance = 0 AND v_wallet = 'synced' THEN 'clean'
                  ELSE 'with_variances'
                END;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_eod_recon',
    p_resource_type       := 'eod_recon',
    p_resource_id         := v_recon_id,
    p_decision_point      := 'submit_eod_recon',
    p_decision_outcome    := v_outcome,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'parcels_count',  p_parcels_count,
                               'mismatch_count', p_mismatch_count,
                               'cash_declared',  p_cash_declared,
                               'cash_counted',   p_cash_counted,
                               'cash_variance',  v_variance,
                               'wallet_status',  v_wallet,
                               'actor_user_id',  v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_outcome,
    'recon_id', v_recon_id,
    'cash_variance', v_variance
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID) IS
  'Mobile V2 EOD reconciliation write. Validates non-negative counts/amounts and wallet_status in {synced,stale,offline}. Decision-log only (no row). Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_eod_recon_v1(
  p_parcels_count INT,
  p_mismatch_count INT,
  p_cash_declared NUMERIC,
  p_cash_counted NUMERIC,
  p_wallet_status TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_eod_recon_v1(p_parcels_count, p_mismatch_count, p_cash_declared, p_cash_counted, p_wallet_status, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_eod_recon_v1(INT, INT, NUMERIC, NUMERIC, TEXT, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605120400_fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2'));
COMMIT;
