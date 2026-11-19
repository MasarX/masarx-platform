-- Plan: PHASE B / Step: B5 (INSIGHTS api-gateway operational write contract)
-- Migration: adjust_api_gateway_rate_limit_v1 — set webhook_sources.rate_limit_per_hour
-- Date: 2026-04-28
--
-- Purpose:
--   The INSIGHTS FE re-audit (apps/console-v2/__audit__/REAUDIT/INSIGHTS.md §D2)
--   shows api-gateway.tsx exposes an "Adjust rate limit" UX action that is
--   currently a stub (toast-only, no canonical RPC). Backend has no write RPC
--   for tuning a source's rate limit; the surface gates a no-op. This
--   migration introduces the canonical
--   `public.adjust_api_gateway_rate_limit_v1(p_args jsonb)` write RPC.
--
--   Canonical schema for `webhook_sources` already exposes a
--   `rate_limit_per_hour` column (per
--   202510110004_webhook_integration.sql). The FE form's per-route /
--   per-minute semantics are an FE-only roll-up; the canonical write
--   target is the source bucket itself. The RPC therefore accepts the
--   source-level limit (per hour) with optional metadata that records the
--   FE-side intent (e.g., a per-minute display value) for audit.
--
-- Contract:
--   - Capability: api_gateway.write (canonical key registered in
--     access_control_policy.capabilities — registered alongside the block
--     RPC migration 202604280330).
--   - Tenant isolation: explicit org-membership guard inside body.
--   - Idempotent: re-calling with the same limit returns the same envelope
--     with already_processed=true; no duplicate domain_event/decision_log.
--   - Append-only event ledger via domain_events.
--   - Decision audit via log_decision tied to the canonical
--     `api_gateway_source_lifecycle` decision_category.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280331_adjust_api_gateway_rate_limit_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Lookup outcome seed: rate_limit_adjusted decision_outcome
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_decision_outcome_def UUID;
BEGIN
  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NULL THEN
    RAISE WARNING 'decision_outcome lookup_definition missing; skipping rate_limit_adjusted seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES
      (v_decision_outcome_def, 'rate_limit_adjusted', 'Rate limit adjusted', 'active', 2022)
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) adjust_api_gateway_rate_limit_v1 RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.adjust_api_gateway_rate_limit_v1(p_args JSONB)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_caller_org_id UUID := public.current_user_org_id();
  v_source_id_text TEXT := NULLIF(btrim(COALESCE(p_args->>'source_id', '')), '');
  v_source_id UUID;
  v_limit_per_hour INT;
  v_limit_per_min INT;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_source public.webhook_sources%ROWTYPE;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_metadata_input JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
  v_previous_limit INT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- 1) Capability gate (raises capability_denied if missing)
  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_caller_org_id);

  -- 2) Validate input — source_id required + at least one of
  --    limit_per_hour or limit_per_min must be present. If only
  --    limit_per_min is supplied, derive the hourly equivalent (×60).
  IF v_source_id_text IS NULL THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 requires source_id' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_source_id := v_source_id_text::UUID;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 invalid source_id %', v_source_id_text USING ERRCODE = '22023';
  END;

  IF (p_args ? 'limit_per_hour') AND jsonb_typeof(p_args->'limit_per_hour') = 'number' THEN
    v_limit_per_hour := (p_args->>'limit_per_hour')::INT;
  END IF;

  IF (p_args ? 'limit_per_min') AND jsonb_typeof(p_args->'limit_per_min') = 'number' THEN
    v_limit_per_min := (p_args->>'limit_per_min')::INT;
    IF v_limit_per_hour IS NULL THEN
      v_limit_per_hour := v_limit_per_min * 60;
    END IF;
  END IF;

  IF v_limit_per_hour IS NULL THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 requires limit_per_hour or limit_per_min' USING ERRCODE = '22023';
  END IF;

  IF v_limit_per_hour <= 0 THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 limit must be > 0 (got %)', v_limit_per_hour USING ERRCODE = '22023';
  END IF;

  -- 3) Resolve canonical source row + enforce tenant scope
  SELECT * INTO v_source FROM public.webhook_sources s WHERE s.id = v_source_id FOR UPDATE;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 source % not found', v_source_id USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_source.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'adjust_api_gateway_rate_limit_v1 source % is outside current tenant scope', v_source_id
      USING ERRCODE = '42501';
  END IF;

  v_previous_limit := v_source.rate_limit_per_hour;

  -- 4) Idempotent path: same limit -> return existing envelope
  IF v_previous_limit = v_limit_per_hour THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'source_id', v_source.id,
      'rate_limit_per_hour', v_limit_per_hour,
      'already_processed', TRUE,
      'correlation_id', NULL
    );
  END IF;

  -- 5) Mutate canonical row
  UPDATE public.webhook_sources
     SET rate_limit_per_hour = v_limit_per_hour,
         updated_at = now()
   WHERE id = v_source.id;

  -- 6) Emit domain event (engine-first ledger)
  INSERT INTO public.domain_events (
    organization_id,
    event_type,
    resource_type,
    resource_id,
    correlation_id,
    payload
  )
  VALUES (
    v_source.organization_id,
    'api_gateway.rate_limit.adjusted',
    'webhook_source',
    v_source.id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'organization_id', v_source.organization_id,
      'source_identifier', v_source.source_identifier,
      'previous_limit_per_hour', v_previous_limit,
      'next_limit_per_hour', v_limit_per_hour,
      'fe_limit_per_min', v_limit_per_min,
      'adjusted_by_user_id', v_user_id,
      'reason', v_reason,
      'metadata', v_metadata_input
    ))
  );

  -- 7) Decision audit (settings ladder evidence)
  v_decision_log_id := public.log_decision(
    p_organization_id := v_source.organization_id,
    p_decision_category := 'api_gateway_source_lifecycle',
    p_resource_type := 'webhook_source',
    p_resource_id := v_source.id,
    p_decision_point := 'api_gateway.rate_limit.adjust',
    p_decision_outcome := 'rate_limit_adjusted',
    p_performed_by_system := 'adjust_api_gateway_rate_limit_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'previous_limit_per_hour', v_previous_limit,
      'next_limit_per_hour', v_limit_per_hour,
      'fe_limit_per_min', v_limit_per_min,
      'reason', v_reason,
      'metadata', v_metadata_input
    )),
    p_decision_reason := COALESCE(v_reason, 'api_gateway_rate_limit_adjust_no_reason')
  );

  -- 8) Canonical envelope
  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_id', v_source.id,
    'rate_limit_per_hour', v_limit_per_hour,
    'previous_limit_per_hour', v_previous_limit,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

COMMENT ON FUNCTION public.adjust_api_gateway_rate_limit_v1(JSONB) IS
  'Phase B (B5) canonical write RPC: adjust an API gateway source rate limit (webhook_sources.rate_limit_per_hour) with audit trail. Capability: api_gateway.write. Idempotent. Args: { source_id (uuid, required), limit_per_hour (int) OR limit_per_min (int), reason (text, optional), metadata (jsonb, optional) }.';

REVOKE ALL ON FUNCTION public.adjust_api_gateway_rate_limit_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.adjust_api_gateway_rate_limit_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604280331_adjust_api_gateway_rate_limit_v1'));
COMMIT;
