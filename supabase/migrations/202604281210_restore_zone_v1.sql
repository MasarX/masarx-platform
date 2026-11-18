-- Plan: PHASE B / Step: B4 (NETWORK marketplace + zones RPC contract gap-fill)
-- Migration: restore_zone_v1 — flip zone is_active=true after suspension.
-- Date: 2026-04-28
--
-- Purpose:
--   Companion of suspend_zone_v1 (`202604281200_suspend_zone_v1.sql`). Restores
--   a previously-suspended zone (is_active=TRUE) following the canonical Phase B
--   RPC contract. Tracks the inverse decision_log entry tied to the
--   `zone_lifecycle` decision_category seeded in the suspend migration.
--
-- Contract:
--   - Capability: zones.write (canonical key from access_control_policy)
--   - Tenant isolation: explicit org-membership guard inside body
--   - Idempotent: re-calling on an already-active zone returns
--     already_processed=true; no duplicate domain_event/decision_log
--   - Append-only event ledger via domain_events
--   - Decision audit via log_decision

BEGIN;
SELECT pg_advisory_lock(hashtext('202604281210_restore_zone_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.restore_zone_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_zone_id_text TEXT := NULLIF(btrim(COALESCE(p_args->>'zone_id', '')), '');
  v_zone_id UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_zone public.zones%ROWTYPE;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_metadata_input JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'restore_zone_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- 1) Capability gate
  PERFORM public.assert_capability_v1('zones.write', 'tenant', v_caller_org_id);

  -- 2) Validate input
  IF v_zone_id_text IS NULL THEN
    RAISE EXCEPTION 'restore_zone_v1 requires zone_id' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_zone_id := v_zone_id_text::UUID;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'restore_zone_v1 invalid zone_id %', v_zone_id_text USING ERRCODE = '22023';
  END;

  -- 3) Resolve canonical zone row + enforce tenant scope
  SELECT * INTO v_zone FROM public.zones z WHERE z.id = v_zone_id FOR UPDATE;

  IF v_zone.id IS NULL THEN
    RAISE EXCEPTION 'restore_zone_v1 zone % not found', v_zone_id USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_zone.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'restore_zone_v1 zone % is outside current tenant scope', v_zone_id
      USING ERRCODE = '42501';
  END IF;

  -- 4) Idempotent path: already active -> return existing envelope
  IF v_zone.is_active = TRUE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'zone_id', v_zone.id,
      'is_active', TRUE,
      'already_processed', TRUE,
      'correlation_id', NULL
    );
  END IF;

  -- 5) Mutate canonical row (clear suspension fields from metadata)
  UPDATE public.zones
     SET is_active = TRUE,
         metadata = (COALESCE(metadata, '{}'::jsonb) - 'suspended_at' - 'suspended_by_user_id' - 'suspended_reason')
                 || jsonb_strip_nulls(jsonb_build_object(
                      'restored_at', to_jsonb(now()),
                      'restored_by_user_id', to_jsonb(v_user_id),
                      'restored_reason', v_reason
                    )),
         updated_at = now()
   WHERE id = v_zone.id;

  -- 6) Emit domain event
  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload
  )
  VALUES (
    v_zone.organization_id,
    'zone.restored',
    'zone',
    v_zone.id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'zone_id', v_zone.id,
      'organization_id', v_zone.organization_id,
      'restored_by_user_id', v_user_id,
      'reason', v_reason,
      'metadata', v_metadata_input
    ))
  );

  -- 7) Decision audit
  v_decision_log_id := public.log_decision(
    p_organization_id := v_zone.organization_id,
    p_decision_category := 'zone_lifecycle',
    p_resource_type := 'zone',
    p_resource_id := v_zone.id,
    p_decision_point := 'zone.restore',
    p_decision_outcome := 'restored',
    p_performed_by_system := 'restore_zone_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'zone_id', v_zone.id,
      'previous_is_active', FALSE,
      'reason', v_reason,
      'metadata', v_metadata_input
    )),
    p_decision_reason := COALESCE(v_reason, 'zone_restore_no_reason')
  );

  -- 8) Canonical envelope
  RETURN jsonb_build_object(
    'ok', TRUE,
    'zone_id', v_zone.id,
    'is_active', TRUE,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

COMMENT ON FUNCTION public.restore_zone_v1(JSONB) IS
  'Phase B (B4) canonical write RPC: restore a suspended zone (is_active=TRUE) with audit trail. Capability: zones.write. Idempotent. Args: { zone_id (uuid, required), reason (text, optional), metadata (jsonb, optional) }.';

REVOKE ALL ON FUNCTION public.restore_zone_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.restore_zone_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604281210_restore_zone_v1'));
COMMIT;
