-- Plan: PHASE B / Step: B5 (INSIGHTS api-gateway operational write contract)
-- Migration: block_api_gateway_source_v1 — flip webhook_sources.enabled = FALSE
-- Date: 2026-04-28
--
-- Purpose:
--   The INSIGHTS FE re-audit (apps/console-v2/__audit__/REAUDIT/INSIGHTS.md §D1)
--   shows api-gateway.tsx exposes a "Block source" UX action that is currently
--   a stub (toast-only, no canonical RPC). Backend has no write RPC for source
--   blocking; the surface gates a no-op. This migration introduces the canonical
--   `public.block_api_gateway_source_v1(p_args jsonb)` write RPC following the
--   Phase B canonical RPC contract (capability gate + tenant scope guard +
--   domain event + decision_log entry tied to canonical lookups).
--
-- Contract:
--   - Capability: api_gateway.write (canonical key registered in
--     access_control_policy.capabilities; ops_admin and platform roles receive
--     it via existing role-template seeds).
--   - Tenant isolation: explicit org-membership guard inside body (FE clients
--     can never block a source in another tenant; platform users may block
--     across tenants for incident response).
--   - Idempotent: re-calling on an already-blocked source returns the same
--     envelope with already_processed=true; no duplicate domain_event/
--     decision_log entries.
--   - Append-only event ledger via domain_events.
--   - Decision audit via log_decision tied to a new
--     `api_gateway_source_lifecycle` decision_category.

BEGIN;
SELECT pg_advisory_lock(hashtext('202604280330_block_api_gateway_source_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-- ---------------------------------------------------------------------------
-- 1) Lookup category seeds: api_gateway_source_lifecycle decision_category +
--    blocked / unblocked decision_outcomes
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_decision_category_def UUID;
  v_decision_outcome_def UUID;
BEGIN
  -- decision_category: api_gateway_source_lifecycle
  SELECT id INTO v_decision_category_def
    FROM public.lookup_definitions
   WHERE category = 'decision_category'
   LIMIT 1;

  IF v_decision_category_def IS NULL THEN
    RAISE WARNING 'decision_category lookup_definition missing; skipping api_gateway_source_lifecycle seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES (
      v_decision_category_def,
      'api_gateway_source_lifecycle',
      'API gateway source lifecycle (block/unblock)',
      'active',
      1020
    )
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;

  -- decision_outcome: blocked / unblocked
  SELECT id INTO v_decision_outcome_def
    FROM public.lookup_definitions
   WHERE category = 'decision_outcome'
   LIMIT 1;

  IF v_decision_outcome_def IS NULL THEN
    RAISE WARNING 'decision_outcome lookup_definition missing; skipping blocked/unblocked seed';
  ELSE
    INSERT INTO public.lookup_values (lookup_definition_id, value, label, status, sort_order)
    VALUES
      (v_decision_outcome_def, 'blocked', 'Blocked', 'active', 2020),
      (v_decision_outcome_def, 'unblocked', 'Unblocked', 'active', 2021)
    ON CONFLICT (lookup_definition_id, value) DO NOTHING;
  END IF;
END $$;

-- ---------------------------------------------------------------------------
-- 2) Register api_gateway.write capability + ops_admin assignment
-- ---------------------------------------------------------------------------

DO $$
DECLARE
  v_current JSONB;
  v_caps JSONB;
  v_roles JSONB := '[]'::jsonb;
  v_role JSONB;
  v_settings_version_id UUID;
  v_version INT;
  v_schema_version INT;
  v_new_caps JSONB := jsonb_build_array(
    jsonb_build_object('key', 'api_gateway.read',  'label', 'API gateway read',  'category', 'observability'),
    jsonb_build_object('key', 'api_gateway.write', 'label', 'API gateway write', 'category', 'observability')
  );
  v_cap JSONB;
BEGIN
  SELECT s.settings_version_id, sv.value, sv.version, sv.schema_version
    INTO v_settings_version_id, v_current, v_version, v_schema_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
   WHERE s.category = 'access_control_policy'
     AND s.scope_type = 'global'
     AND s.scope_id IS NULL
   LIMIT 1;

  IF v_current IS NULL THEN
    RAISE WARNING 'access_control_policy global settings missing; skipping api_gateway.* capability seed';
    RETURN;
  END IF;

  v_caps := COALESCE(v_current->'capabilities', '[]'::jsonb);
  FOR v_cap IN SELECT * FROM jsonb_array_elements(v_new_caps) LOOP
    IF NOT EXISTS (
      SELECT 1
        FROM jsonb_array_elements(v_caps) AS item
       WHERE item->>'key' = v_cap->>'key'
    ) THEN
      v_caps := v_caps || jsonb_build_array(v_cap);
    END IF;
  END LOOP;

  -- Grant api_gateway.* capabilities to ops_admin
  v_roles := '[]'::jsonb;
  FOR v_role IN SELECT * FROM jsonb_array_elements(COALESCE(v_current->'roles', '[]'::jsonb)) LOOP
    IF v_role->>'key' = 'ops_admin' THEN
      v_role := jsonb_set(
        v_role,
        '{capability_keys}',
        to_jsonb(ARRAY(
          SELECT DISTINCT cap
            FROM (
              SELECT jsonb_array_elements_text(COALESCE(v_role->'capability_keys', '[]'::jsonb)) AS cap
              UNION ALL SELECT unnest(ARRAY['api_gateway.read', 'api_gateway.write']) AS cap
            ) AS caps
           ORDER BY cap
        )),
        false
      );
    END IF;
    v_roles := v_roles || jsonb_build_array(v_role);
  END LOOP;

  v_current := jsonb_set(v_current, '{capabilities}', v_caps, true);
  v_current := jsonb_set(v_current, '{roles}', v_roles, true);

  UPDATE public.settings_versions
     SET value = v_current,
         schema_version = COALESCE(v_schema_version, 1),
         version = v_version
   WHERE id = v_settings_version_id;
END $$;

-- ---------------------------------------------------------------------------
-- 3) block_api_gateway_source_v1 RPC
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.block_api_gateway_source_v1(p_args JSONB)
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
  v_reason TEXT := NULLIF(btrim(COALESCE(p_args->>'reason', '')), '');
  v_source public.webhook_sources%ROWTYPE;
  v_correlation_id UUID := gen_random_uuid();
  v_decision_log_id UUID;
  v_metadata_input JSONB := COALESCE(p_args->'metadata', '{}'::jsonb);
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 requires authenticated user' USING ERRCODE = '42501';
  END IF;

  -- 1) Capability gate (raises capability_denied if missing)
  PERFORM public.assert_capability_v1('api_gateway.write', 'tenant', v_caller_org_id);

  -- 2) Validate input
  IF v_source_id_text IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 requires source_id' USING ERRCODE = '22023';
  END IF;

  BEGIN
    v_source_id := v_source_id_text::UUID;
  EXCEPTION
    WHEN OTHERS THEN
      RAISE EXCEPTION 'block_api_gateway_source_v1 invalid source_id %', v_source_id_text USING ERRCODE = '22023';
  END;

  -- 3) Resolve canonical source row + enforce tenant scope
  SELECT * INTO v_source FROM public.webhook_sources s WHERE s.id = v_source_id FOR UPDATE;

  IF v_source.id IS NULL THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 source % not found', v_source_id USING ERRCODE = '23503';
  END IF;

  IF NOT public.is_platform_user() AND v_source.organization_id <> v_caller_org_id THEN
    RAISE EXCEPTION 'block_api_gateway_source_v1 source % is outside current tenant scope', v_source_id
      USING ERRCODE = '42501';
  END IF;

  -- 4) Idempotent path: already blocked -> return existing envelope
  IF v_source.enabled = FALSE THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'source_id', v_source.id,
      'enabled', FALSE,
      'already_processed', TRUE,
      'correlation_id', NULL
    );
  END IF;

  -- 5) Mutate canonical row
  UPDATE public.webhook_sources
     SET enabled = FALSE,
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
    'api_gateway.source.blocked',
    'webhook_source',
    v_source.id,
    v_correlation_id,
    jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'organization_id', v_source.organization_id,
      'source_identifier', v_source.source_identifier,
      'blocked_by_user_id', v_user_id,
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
    p_decision_point := 'api_gateway.source.block',
    p_decision_outcome := 'blocked',
    p_performed_by_system := 'block_api_gateway_source_v1',
    p_correlation_id := v_correlation_id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
      'source_id', v_source.id,
      'previous_enabled', TRUE,
      'reason', v_reason,
      'metadata', v_metadata_input
    )),
    p_decision_reason := COALESCE(v_reason, 'api_gateway_source_block_no_reason')
  );

  -- 8) Canonical envelope
  RETURN jsonb_build_object(
    'ok', TRUE,
    'source_id', v_source.id,
    'enabled', FALSE,
    'already_processed', FALSE,
    'correlation_id', v_correlation_id,
    'decision_log_id', v_decision_log_id
  );
END;
$function$;

COMMENT ON FUNCTION public.block_api_gateway_source_v1(JSONB) IS
  'Phase B (B5) canonical write RPC: block an API gateway source (webhook_sources.enabled=FALSE) with audit trail. Capability: api_gateway.write. Idempotent. Args: { source_id (uuid, required), reason (text, optional), metadata (jsonb, optional) }.';

REVOKE ALL ON FUNCTION public.block_api_gateway_source_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.block_api_gateway_source_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202604280330_block_api_gateway_source_v1'));
COMMIT;
