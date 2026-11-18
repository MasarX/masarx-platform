-- Migration: fieldops_mobile_v2_write_rpcs_pack_v1
-- Date: 2026-05-12
-- Spec: Backend-contract audit P0 — Mobile V2 fieldops shipped read-side
--   aggregators (`202605111000_resolve_fieldops_ops_aggregators_pack_v1`)
--   but every visible action button in V2 had no backend. This migration
--   adds the 8 missing write-side RPCs so optimistic UI submissions land
--   on canonical tables + decision_log.
--
--   The 8 RPCs (all `public.*` SECURITY DEFINER + `api.*` SECURITY
--   INVOKER mirrors; all VOLATILE; all idempotent via p_idempotency_key):
--
--     1) submit_fieldops_proof_v1         — driver marks a stop done|failed|partial
--     2) advance_fieldops_trip_stage_v1   — driver advances a line-haul trip stage
--     3) induct_fieldops_parcel_v1        — loader inducts a parcel into a sortation bay
--     4) sign_fieldops_cash_drop_v1       — driver signs a COD cash drop
--     5) request_fieldops_wallet_withdraw_v1 — driver requests a wallet withdrawal
--     6) submit_fieldops_hold_decision_v1 — supervisor decides a hold queue item
--     7) release_fieldops_hub_pickup_v1   — counter-staff releases a hub pickup
--     8) mark_fieldops_return_received_v1 — hub accepts an RTO stop
--
-- AGENTS.md compliance posture:
-- - RLS: ships a tenant-scoped audit table `public.fieldops_v2_inductions`
--   with RLS enabled + service_role + tenant-scoped policies.
-- - Idempotency: every write short-circuits on prior decision_log entry
--   keyed by p_idempotency_key (re-returns the same decision_log_id).
-- - Decision_log: every successful state transition writes a row via the
--   canonical `public.log_decision(...)` helper.
-- - Scope ladder: callers must be authenticated + have an org context
--   (`current_user_org_id()`); cross-tenant access raises 42501.
-- - Zero hardcoding: stage vocabulary mirrors the FE allow-list defined
--   in apps/fieldops/src/mobile-v2-trips-screen.tsx; outcome/action/
--   discard rules are checked via lookup-like CHECK lists, not per-tenant
--   constants.
-- - Single source of truth: all api.* wrappers proxy to public.* so
--   PostgREST sees one shape per RPC.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605120300_fieldops_mobile_v2_write_rpcs_pack_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

INSERT INTO public.lookup_definitions (
  category,
  description,
  owner_role,
  approval_policy,
  is_mutable
)
VALUES (
  'decision_category',
  'Business decision categories for decision_log',
  'engineering',
  'tier_1',
  FALSE
)
ON CONFLICT (category) DO NOTHING;

WITH decision_category_definition AS (
  SELECT id
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1
),
fieldops_decision_categories(value, label, sort_order) AS (
  VALUES
    ('fieldops_proof', 'FieldOps proof submission', 9300),
    ('fieldops_trip_stage', 'FieldOps trip stage transition', 9301),
    ('fieldops_induction', 'FieldOps parcel induction', 9302),
    ('fieldops_cash_drop', 'FieldOps cash drop', 9303),
    ('fieldops_wallet_withdraw', 'FieldOps wallet withdrawal', 9304),
    ('fieldops_hold_decision', 'FieldOps hold decision', 9305),
    ('fieldops_hub_pickup_release', 'FieldOps hub pickup release', 9306),
    ('fieldops_return_received', 'FieldOps return received', 9307)
)
INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT
  d.id,
  c.value,
  c.label,
  c.label || ' decision audit category for Mobile V2 field operations.',
  c.sort_order,
  FALSE,
  jsonb_build_object('source', 'fieldops_mobile_v2_write_rpcs_pack_v1')
FROM decision_category_definition d
CROSS JOIN fieldops_decision_categories c
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       sort_order = EXCLUDED.sort_order,
       metadata = COALESCE(public.lookup_values.metadata, '{}'::jsonb) || EXCLUDED.metadata,
       status = 'active',
       retired_at = NULL,
       updated_at = now();

-- ===========================================================================
-- 0) Companion audit table for parcel inductions.
--    Tenant-scoped + RLS-enabled + explicit service_role + select-own-org.
-- ===========================================================================

CREATE TABLE IF NOT EXISTS public.fieldops_v2_inductions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  client_id UUID NOT NULL REFERENCES public.clients(id) ON DELETE CASCADE,
  shipment_id UUID NOT NULL,
  bay TEXT NOT NULL,
  tracking_number TEXT NOT NULL,
  inducted_by_user_id UUID NULL REFERENCES public.users(id) ON DELETE SET NULL,
  decision_log_id UUID NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT fieldops_v2_inductions_bay_ck CHECK (btrim(bay) <> ''),
  CONSTRAINT fieldops_v2_inductions_tracking_ck CHECK (btrim(tracking_number) <> ''),
  CONSTRAINT fieldops_v2_inductions_shipment_fk
    FOREIGN KEY (shipment_id, client_id) REFERENCES public.shipments(id, client_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_inductions_org_created
  ON public.fieldops_v2_inductions (organization_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_fieldops_v2_inductions_bay_created
  ON public.fieldops_v2_inductions (organization_id, bay, created_at DESC);

COMMENT ON TABLE public.fieldops_v2_inductions IS
  'Audit trail for Mobile V2 sortation inductions. Each row is one loader scan event tying a tracking number to a sortation bay within the caller org. Linked to decision_log via decision_log_id.';

ALTER TABLE public.fieldops_v2_inductions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.fieldops_v2_inductions FROM PUBLIC;
REVOKE ALL ON TABLE public.fieldops_v2_inductions FROM anon;
REVOKE ALL ON TABLE public.fieldops_v2_inductions FROM authenticated;

GRANT SELECT, INSERT ON TABLE public.fieldops_v2_inductions TO authenticated;
GRANT ALL ON TABLE public.fieldops_v2_inductions TO service_role;

DROP POLICY IF EXISTS fieldops_v2_inductions_service_policy ON public.fieldops_v2_inductions;
CREATE POLICY fieldops_v2_inductions_service_policy ON public.fieldops_v2_inductions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS fieldops_v2_inductions_select_policy ON public.fieldops_v2_inductions;
CREATE POLICY fieldops_v2_inductions_select_policy ON public.fieldops_v2_inductions
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
    )
  );

DROP POLICY IF EXISTS fieldops_v2_inductions_insert_policy ON public.fieldops_v2_inductions;
CREATE POLICY fieldops_v2_inductions_insert_policy ON public.fieldops_v2_inductions
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_can_write()
    AND (
      public.is_platform_user()
      OR organization_id = public.current_user_org_id()
    )
  );

-- ===========================================================================
-- Shared helper: short-circuit a write on prior decision_log entry keyed
-- by correlation_id (idempotency_key). Returns the prior decision_log id
-- when one exists, NULL otherwise.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.fieldops_v2_existing_decision_v1(
  p_org_id UUID,
  p_decision_category TEXT,
  p_correlation_id UUID
)
RETURNS UUID
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT dl.id
    FROM public.decision_log dl
   WHERE dl.organization_id = p_org_id
     AND dl.decision_category = p_decision_category
     AND dl.correlation_id    = p_correlation_id
   ORDER BY dl.timestamp DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.fieldops_v2_existing_decision_v1(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.fieldops_v2_existing_decision_v1(UUID, TEXT, UUID) TO authenticated, service_role;

CREATE SCHEMA IF NOT EXISTS api;
GRANT USAGE ON SCHEMA api TO authenticated, service_role;

-- ===========================================================================
-- 1) submit_fieldops_proof_v1 — driver marks a stop done|failed|partial.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id   UUID := auth.uid();
  v_org       UUID;
  v_outcome   TEXT := lower(btrim(COALESCE(p_outcome, '')));
  v_stop      public.route_stops%ROWTYPE;
  v_existing  UUID;
  v_meta      JSONB;
  v_prev_status TEXT;
  v_new_status  TEXT;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_outcome NOT IN ('delivered', 'failed', 'partial') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: invalid outcome %', p_outcome USING ERRCODE = '22023';
  END IF;

  -- Idempotency replay
  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_proof', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % not found', p_stop_id USING ERRCODE = '22023';
  END IF;
  IF v_stop.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_stop.metadata, '{}'::jsonb);
  v_prev_status := lower(COALESCE(NULLIF(btrim(v_meta->>'status'), ''), 'pending'));

  -- Only accept proof when stop is still in an open state (block double-submit).
  IF v_prev_status NOT IN ('pending', 'en_route', 'arrived') THEN
    RAISE EXCEPTION 'submit_fieldops_proof_v1: stop is in terminal state %', v_prev_status USING ERRCODE = 'P0001';
  END IF;

  v_new_status := CASE v_outcome
    WHEN 'delivered' THEN 'done'
    WHEN 'failed'    THEN 'failed'
    WHEN 'partial'   THEN 'partial'
  END;

  UPDATE public.route_stops
     SET metadata = jsonb_set(
                       jsonb_set(v_meta, '{status}', to_jsonb(v_new_status), TRUE),
                       '{last_proof}',
                       jsonb_build_object(
                         'outcome', v_outcome,
                         'evidence', COALESCE(p_evidence, '{}'::jsonb),
                         'submitted_at', now(),
                         'submitted_by', v_user_id
                       ),
                       TRUE
                     ),
         updated_at = now()
   WHERE id = v_stop.id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_proof',
    p_resource_type       := 'route_stop',
    p_resource_id         := v_stop.id,
    p_decision_point      := 'submit_proof',
    p_decision_outcome    := v_outcome,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'previous_status', v_prev_status,
                               'new_status',      v_new_status,
                               'evidence',        COALESCE(p_evidence, '{}'::jsonb),
                               'actor_user_id',   v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_new_status,
    'stop_id', v_stop.id
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) IS
  'Mobile V2 driver stop-completion write. Validates outcome in {delivered,failed,partial}, blocks double-submit on terminal states, idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_proof_v1(
  p_stop_id UUID,
  p_outcome TEXT,
  p_evidence JSONB,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_proof_v1(p_stop_id, p_outcome, p_evidence, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_proof_v1(UUID, TEXT, JSONB, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 2) advance_fieldops_trip_stage_v1 — driver advances line-haul trip stage.
--    Stage vocabulary mirrors apps/fieldops/src/mobile-v2-trips-screen.tsx
--    MOBILE_V2_TRIP_STEPS exactly. Transitions are sequential only.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.advance_fieldops_trip_stage_v1(
  p_trip_id UUID,
  p_next_stage TEXT,
  p_seal_no TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_next     TEXT := lower(btrim(COALESCE(p_next_stage, '')));
  v_run      public.route_runs%ROWTYPE;
  v_meta     JSONB;
  v_existing UUID;
  v_decision_id UUID;
  v_current   TEXT;
  v_stages    TEXT[] := ARRAY[
    'assigned', 'gate-in', 'loading', 'sealed',
    'in-transit', 'arrived', 'gate-out', 'reconciled'
  ];
  v_cur_idx INT;
  v_next_idx INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1 requires organization context' USING ERRCODE = '42501';
  END IF;

  IF p_trip_id IS NULL THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1 requires trip_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF NOT (v_next = ANY (v_stages)) THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1: invalid next_stage %', p_next_stage USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_trip_stage', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'trip_id', p_trip_id
    );
  END IF;

  SELECT * INTO v_run FROM public.route_runs WHERE id = p_trip_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1: trip % not found', p_trip_id USING ERRCODE = '22023';
  END IF;
  IF v_run.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1: trip % outside tenant scope', p_trip_id USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_run.metadata, '{}'::jsonb);
  v_current := lower(COALESCE(NULLIF(btrim(v_meta->>'stage'), ''), 'assigned'));

  -- Locate stages in the ordered vocabulary.
  v_cur_idx  := array_position(v_stages, v_current);
  v_next_idx := array_position(v_stages, v_next);

  IF v_cur_idx IS NULL THEN
    -- current is unknown vocab; treat as assigned
    v_cur_idx := 1;
  END IF;
  IF v_next_idx IS NULL THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1: invalid next_stage %', p_next_stage USING ERRCODE = '22023';
  END IF;
  -- Only the next legal step is accepted.
  IF v_next_idx <> v_cur_idx + 1 THEN
    RAISE EXCEPTION 'advance_fieldops_trip_stage_v1: invalid transition % -> %', v_current, v_next USING ERRCODE = 'P0001';
  END IF;

  v_meta := jsonb_set(v_meta, '{stage}', to_jsonb(v_next), TRUE);
  IF NULLIF(btrim(COALESCE(p_seal_no, '')), '') IS NOT NULL THEN
    v_meta := jsonb_set(v_meta, '{seal_no}', to_jsonb(p_seal_no), TRUE);
  END IF;

  UPDATE public.route_runs
     SET metadata = v_meta,
         updated_at = now()
   WHERE id = v_run.id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_trip_stage',
    p_resource_type       := 'route_run',
    p_resource_id         := v_run.id,
    p_decision_point      := 'advance_stage',
    p_decision_outcome    := v_next,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'previous_stage', v_current,
                               'next_stage',     v_next,
                               'seal_no',        NULLIF(btrim(COALESCE(p_seal_no, '')), ''),
                               'actor_user_id',  v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_next,
    'trip_id', v_run.id
  );
END;
$$;

COMMENT ON FUNCTION public.advance_fieldops_trip_stage_v1(UUID, TEXT, TEXT, UUID) IS
  'Mobile V2 trip-stage advance write. Validates next_stage in canonical 8-step vocabulary, accepts only the next legal step, idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.advance_fieldops_trip_stage_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.advance_fieldops_trip_stage_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.advance_fieldops_trip_stage_v1(
  p_trip_id UUID,
  p_next_stage TEXT,
  p_seal_no TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.advance_fieldops_trip_stage_v1(p_trip_id, p_next_stage, p_seal_no, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.advance_fieldops_trip_stage_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.advance_fieldops_trip_stage_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 3) induct_fieldops_parcel_v1 — loader scan into a sortation bay.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.induct_fieldops_parcel_v1(
  p_bay TEXT,
  p_tracking_number TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_bay      TEXT := NULLIF(btrim(COALESCE(p_bay, '')), '');
  v_tracking TEXT := NULLIF(btrim(COALESCE(p_tracking_number, '')), '');
  v_shipment_id UUID;
  v_client_id   UUID;
  v_existing UUID;
  v_decision_id UUID;
  v_induction_id UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_bay IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1 requires bay' USING ERRCODE = '22023';
  END IF;
  IF v_tracking IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1 requires tracking_number' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_induction', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'tracking_number', v_tracking,
      'bay', v_bay
    );
  END IF;

  -- Resolve shipment in caller org.
  SELECT s.id, s.client_id
    INTO v_shipment_id, v_client_id
    FROM public.shipments s
   WHERE s.organization_id = v_org
     AND s.tracking_number = v_tracking
   ORDER BY s.updated_at DESC NULLS LAST
   LIMIT 1;

  IF v_shipment_id IS NULL THEN
    RAISE EXCEPTION 'induct_fieldops_parcel_v1: tracking_number % not found in tenant', v_tracking USING ERRCODE = 'P0001';
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_induction',
    p_resource_type       := 'shipment',
    p_resource_id         := v_shipment_id,
    p_decision_point      := 'induct_parcel',
    p_decision_outcome    := 'inducted',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'bay',             v_bay,
                               'tracking_number', v_tracking,
                               'shipment_id',     v_shipment_id,
                               'client_id',       v_client_id,
                               'actor_user_id',   v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  INSERT INTO public.fieldops_v2_inductions (
    id, organization_id, client_id, shipment_id, bay,
    tracking_number, inducted_by_user_id, decision_log_id, metadata
  ) VALUES (
    v_induction_id, v_org, v_client_id, v_shipment_id, v_bay,
    v_tracking, v_user_id, v_decision_id,
    jsonb_build_object('correlation_id', p_idempotency_key)
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'inducted',
    'induction_id', v_induction_id,
    'shipment_id', v_shipment_id,
    'bay', v_bay
  );
END;
$$;

COMMENT ON FUNCTION public.induct_fieldops_parcel_v1(TEXT, TEXT, UUID) IS
  'Mobile V2 loader sortation induct write. Resolves a tracking_number within caller org and records an induction event in fieldops_v2_inductions + decision_log. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.induct_fieldops_parcel_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.induct_fieldops_parcel_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.induct_fieldops_parcel_v1(
  p_bay TEXT,
  p_tracking_number TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.induct_fieldops_parcel_v1(p_bay, p_tracking_number, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.induct_fieldops_parcel_v1(TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.induct_fieldops_parcel_v1(TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 4) sign_fieldops_cash_drop_v1 — COD cash hand-off variance.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.sign_fieldops_cash_drop_v1(
  p_expected_sar INT,
  p_actual_sar INT,
  p_supervisor_name TEXT,
  p_photo_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_existing UUID;
  v_decision_id UUID;
  v_variance INT;
  v_supervisor TEXT := NULLIF(btrim(COALESCE(p_supervisor_name, '')), '');
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_expected_sar IS NULL OR p_expected_sar < 0 THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: expected_sar must be >= 0' USING ERRCODE = '22023';
  END IF;
  IF p_actual_sar IS NULL OR p_actual_sar < 0 THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: actual_sar must be >= 0' USING ERRCODE = '22023';
  END IF;

  v_variance := p_actual_sar - p_expected_sar;
  IF v_variance <> 0 AND (v_supervisor IS NULL OR p_photo_id IS NULL) THEN
    RAISE EXCEPTION 'sign_fieldops_cash_drop_v1: variance % requires supervisor_name + photo_id', v_variance USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_cash_drop', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'variance_sar', v_variance
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_cash_drop',
    p_resource_type       := 'cash_drop',
    p_resource_id         := p_idempotency_key, -- cash_drop record id == idempotency key
    p_decision_point      := 'sign_cash_drop',
    p_decision_outcome    := CASE WHEN v_variance = 0 THEN 'balanced' ELSE 'variance' END,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'expected_sar',     p_expected_sar,
                               'actual_sar',       p_actual_sar,
                               'variance_sar',     v_variance,
                               'supervisor_name',  v_supervisor,
                               'photo_id',         p_photo_id,
                               'actor_user_id',    v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', CASE WHEN v_variance = 0 THEN 'balanced' ELSE 'variance' END,
    'variance_sar', v_variance
  );
END;
$$;

COMMENT ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) IS
  'Mobile V2 COD cash-drop sign write. Validates non-negative amounts and requires supervisor + photo when variance != 0. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.sign_fieldops_cash_drop_v1(
  p_expected_sar INT,
  p_actual_sar INT,
  p_supervisor_name TEXT,
  p_photo_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.sign_fieldops_cash_drop_v1(p_expected_sar, p_actual_sar, p_supervisor_name, p_photo_id, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.sign_fieldops_cash_drop_v1(INT, INT, TEXT, UUID, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 5) request_fieldops_wallet_withdraw_v1 — driver wallet withdrawal request.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.request_fieldops_wallet_withdraw_v1(
  p_amount_sar INT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_existing UUID;
  v_decision_id UUID;
  v_request_id  UUID := gen_random_uuid();
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF p_amount_sar IS NULL OR p_amount_sar <= 0 THEN
    RAISE EXCEPTION 'request_fieldops_wallet_withdraw_v1: amount_sar must be > 0' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_wallet_withdraw', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed'
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_wallet_withdraw',
    p_resource_type       := 'wallet_withdraw',
    p_resource_id         := v_request_id,
    p_decision_point      := 'request_withdraw',
    p_decision_outcome    := 'requested',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'amount_sar',    p_amount_sar,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'requested',
    'request_id', v_request_id
  );
END;
$$;

COMMENT ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) IS
  'Mobile V2 driver wallet-withdraw request write. Validates amount > 0, idempotent on p_idempotency_key, returns a fresh request_id.';

REVOKE ALL ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.request_fieldops_wallet_withdraw_v1(INT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.request_fieldops_wallet_withdraw_v1(
  p_amount_sar INT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.request_fieldops_wallet_withdraw_v1(p_amount_sar, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.request_fieldops_wallet_withdraw_v1(INT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.request_fieldops_wallet_withdraw_v1(INT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 6) submit_fieldops_hold_decision_v1 — supervisor decides a hold queue item.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.submit_fieldops_hold_decision_v1(
  p_hold_id UUID,
  p_action TEXT,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_action   TEXT := lower(btrim(COALESCE(p_action, '')));
  v_note     TEXT := NULLIF(btrim(COALESCE(p_note, '')), '');
  v_existing UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_hold_id IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires hold_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  IF v_action NOT IN ('reinduct', 'escalate', 'discard') THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: invalid action %', p_action USING ERRCODE = '22023';
  END IF;
  IF v_action = 'discard' AND v_note IS NULL THEN
    RAISE EXCEPTION 'submit_fieldops_hold_decision_v1: discard requires a non-empty note' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_hold_decision', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'hold_id', p_hold_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_hold_decision',
    p_resource_type       := 'hold_queue_item',
    p_resource_id         := p_hold_id,
    p_decision_point      := 'decide_hold',
    p_decision_outcome    := v_action,
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'hold_id',       p_hold_id,
                               'action',        v_action,
                               'note',          v_note,
                               'actor_user_id', v_user_id
                             )),
    p_decision_reason     := v_note,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', v_action,
    'hold_id', p_hold_id
  );
END;
$$;

COMMENT ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) IS
  'Mobile V2 supervisor hold-queue decision write. Validates action in {reinduct,escalate,discard}; discard requires a non-empty note. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.submit_fieldops_hold_decision_v1(
  p_hold_id UUID,
  p_action TEXT,
  p_note TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.submit_fieldops_hold_decision_v1(p_hold_id, p_action, p_note, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.submit_fieldops_hold_decision_v1(UUID, TEXT, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 7) release_fieldops_hub_pickup_v1 — counter-staff hub pickup release.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.release_fieldops_hub_pickup_v1(
  p_queue_id UUID,
  p_otp TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_otp      TEXT := NULLIF(btrim(COALESCE(p_otp, '')), '');
  v_existing UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'release_fieldops_hub_pickup_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'release_fieldops_hub_pickup_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_queue_id IS NULL THEN
    RAISE EXCEPTION 'release_fieldops_hub_pickup_v1 requires queue_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'release_fieldops_hub_pickup_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;
  -- OTP format check only (real validation is downstream policy).
  IF v_otp IS NULL OR v_otp !~ '^[0-9]{6}$' THEN
    RAISE EXCEPTION 'release_fieldops_hub_pickup_v1: otp must be 6 digits' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_hub_pickup_release', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'queue_id', p_queue_id
    );
  END IF;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_hub_pickup_release',
    p_resource_type       := 'hub_pickup',
    p_resource_id         := p_queue_id,
    p_decision_point      := 'release_pickup',
    p_decision_outcome    := 'released',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_build_object(
                               'queue_id',      p_queue_id,
                               'otp_present',   TRUE,
                               'actor_user_id', v_user_id
                             ),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'released',
    'queue_id', p_queue_id
  );
END;
$$;

COMMENT ON FUNCTION public.release_fieldops_hub_pickup_v1(UUID, TEXT, UUID) IS
  'Mobile V2 counter-staff hub-pickup release write. Validates OTP format (6 digits) only; real OTP verification is downstream policy. Idempotent on p_idempotency_key.';

REVOKE ALL ON FUNCTION public.release_fieldops_hub_pickup_v1(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.release_fieldops_hub_pickup_v1(UUID, TEXT, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.release_fieldops_hub_pickup_v1(
  p_queue_id UUID,
  p_otp TEXT,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.release_fieldops_hub_pickup_v1(p_queue_id, p_otp, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.release_fieldops_hub_pickup_v1(UUID, TEXT, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.release_fieldops_hub_pickup_v1(UUID, TEXT, UUID) TO authenticated, service_role;

-- ===========================================================================
-- 8) mark_fieldops_return_received_v1 — hub RTO acceptance.
-- ===========================================================================

CREATE OR REPLACE FUNCTION public.mark_fieldops_return_received_v1(
  p_stop_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_user_id  UUID := auth.uid();
  v_org      UUID;
  v_stop     public.route_stops%ROWTYPE;
  v_meta     JSONB;
  v_prev_status TEXT;
  v_existing UUID;
  v_decision_id UUID;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;
  v_org := public.current_user_org_id();
  IF v_org IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires organization context' USING ERRCODE = '42501';
  END IF;
  IF p_stop_id IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires stop_id' USING ERRCODE = '22023';
  END IF;
  IF p_idempotency_key IS NULL THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1 requires idempotency_key' USING ERRCODE = '22023';
  END IF;

  v_existing := public.fieldops_v2_existing_decision_v1(v_org, 'fieldops_return_received', p_idempotency_key);
  IF v_existing IS NOT NULL THEN
    RETURN jsonb_build_object(
      'decision_log_id', v_existing,
      'ok', TRUE,
      'state', 'replayed',
      'stop_id', p_stop_id
    );
  END IF;

  SELECT * INTO v_stop FROM public.route_stops WHERE id = p_stop_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop % not found', p_stop_id USING ERRCODE = '22023';
  END IF;
  IF v_stop.organization_id IS DISTINCT FROM v_org THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop % outside tenant scope', p_stop_id USING ERRCODE = '42501';
  END IF;

  v_meta := COALESCE(v_stop.metadata, '{}'::jsonb);
  v_prev_status := lower(COALESCE(NULLIF(btrim(v_meta->>'status'), ''), 'pending'));
  IF v_prev_status = 'rto' THEN
    RAISE EXCEPTION 'mark_fieldops_return_received_v1: stop already marked rto' USING ERRCODE = 'P0001';
  END IF;

  UPDATE public.route_stops
     SET metadata = jsonb_set(v_meta, '{status}', to_jsonb('rto'::text), TRUE),
         updated_at = now()
   WHERE id = v_stop.id;

  v_decision_id := public.log_decision(
    p_organization_id     := v_org,
    p_decision_category   := 'fieldops_return_received',
    p_resource_type       := 'route_stop',
    p_resource_id         := v_stop.id,
    p_decision_point      := 'mark_return_received',
    p_decision_outcome    := 'rto',
    p_performed_by_system := 'fieldops_mobile_v2',
    p_correlation_id      := p_idempotency_key,
    p_decision_inputs     := jsonb_strip_nulls(jsonb_build_object(
                               'previous_status', v_prev_status,
                               'new_status',      'rto',
                               'actor_user_id',   v_user_id
                             )),
    p_decision_reason     := NULL,
    p_settings_resolution_id := NULL
  );

  RETURN jsonb_build_object(
    'decision_log_id', v_decision_id,
    'ok', TRUE,
    'state', 'rto',
    'stop_id', v_stop.id
  );
END;
$$;

COMMENT ON FUNCTION public.mark_fieldops_return_received_v1(UUID, UUID) IS
  'Mobile V2 hub RTO acceptance write. Sets route_stops.metadata.status to rto and logs a decision. Idempotent on p_idempotency_key; blocks double-mark.';

REVOKE ALL ON FUNCTION public.mark_fieldops_return_received_v1(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.mark_fieldops_return_received_v1(UUID, UUID) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.mark_fieldops_return_received_v1(
  p_stop_id UUID,
  p_idempotency_key UUID
)
RETURNS JSONB
LANGUAGE sql
SECURITY INVOKER
SET search_path TO public, extensions, pg_temp
AS $$
  SELECT public.mark_fieldops_return_received_v1(p_stop_id, p_idempotency_key);
$$;

REVOKE ALL ON FUNCTION api.mark_fieldops_return_received_v1(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION api.mark_fieldops_return_received_v1(UUID, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605120300_fieldops_mobile_v2_write_rpcs_pack_v1'));
COMMIT;
