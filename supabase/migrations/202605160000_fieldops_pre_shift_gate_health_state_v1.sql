-- ===========================================================================
-- Mobile V2 pre-shift gate — return a health-reflecting gate state
--
-- Closes engineering audit finding (2026-05-16): pass_fieldops_pre_shift_gate_v1
-- (migration 202605120400_fieldops_mobile_v2_auth_kyc_sheet_writes_pack_v2.sql)
-- returned `state => 'cleared'` and recorded `decision_outcome =>
-- 'cleared_no_health'` even when `p_health_ok = FALSE`. An unhealthy-
-- attesting driver was therefore recorded as a clearance, and the FE
-- (which models the gate result as cleared/blocked) disagreed with the DB.
--
-- This append-only migration replaces the function body so BOTH the
-- returned `state` and the audit `decision_outcome` reflect the health
-- attestation: cleared when health is OK, blocked otherwise. The pass row
-- is still INSERTed (the `health_ok` column already records the
-- attestation) so the gate decision stays fully auditable either way.
--
-- No signature change — function privileges, the COMMENT, and the
-- `api.pass_fieldops_pre_shift_gate_v1` wrapper are all preserved by
-- CREATE OR REPLACE. pgTAP coverage:
-- `supabase/tests/pgtap/fieldops_mobile_v2_pre_shift_gate_health_state.sql`.
-- ===========================================================================

BEGIN;

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
    p_decision_outcome    := CASE WHEN p_health_ok THEN 'cleared' ELSE 'blocked_health' END,
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
    'state', CASE WHEN p_health_ok THEN 'cleared' ELSE 'blocked' END,
    'pass_id', v_pass_id,
    'shift_id', v_shift,
    'health_ok', p_health_ok
  );
END;
$$;

COMMENT ON FUNCTION public.pass_fieldops_pre_shift_gate_v1(TEXT, BOOLEAN, UUID) IS
  'Mobile V2 pre-shift gate clearance write. Captures shift_id + health attestation; idempotent on p_idempotency_key. Returns state=cleared when health_ok, state=blocked otherwise; the pass row is recorded for audit regardless.';

COMMIT;
