-- Migration: Geocoding source-scoped policy context
-- Purpose:
--   - Carry webhook/source scope through geocoding workflow context extraction.
--   - Resolve geocoding_policy with source > sender > client > tenant > global precedence.
--   - Keep provider dispatch and geocoding decision provenance aligned with the same policy row.

BEGIN;

SET search_path TO public, workflow_handlers, extensions, pg_temp;

CREATE OR REPLACE FUNCTION public.geocoding_extract_policy_context_v1(p_run workflow_runs)
RETURNS TABLE (
    organization_id UUID,
    client_id UUID,
    sender_id UUID,
    shipment_id UUID,
    address_id UUID,
    webhook_source_id UUID
)
LANGUAGE plpgsql
AS $$
DECLARE
    v_context JSONB := COALESCE(p_run.context, '{}'::jsonb);
    v_shipment_id UUID;
    v_address_id UUID;
    v_source_id UUID;
    v_org UUID;
    v_client UUID;
    v_sender UUID;
    v_addr UUID;
    v_context_org UUID;
    v_context_client UUID;
    v_context_sender UUID;
    v_source_org UUID;
    v_source_client UUID;
    v_source_sender UUID;
BEGIN
    v_shipment_id := COALESCE(
        NULLIF(v_context->>'shipment_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->>'shipment_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'id', '')::UUID
    );

    v_address_id := COALESCE(
        NULLIF(v_context->>'address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'shipment'->>'address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'destination_address_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->'shipment'->>'address_id', '')::UUID
    );

    v_source_id := COALESCE(
        NULLIF(v_context->>'webhook_source_id', '')::UUID,
        NULLIF(v_context->>'source_id', '')::UUID,
        NULLIF(v_context->'webhook'->>'source_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->>'webhook_source_id', '')::UUID,
        NULLIF(v_context->'transformed_payload'->>'source_id', '')::UUID
    );

    v_context_org := NULLIF(v_context->>'organization_id', '')::UUID;
    v_context_client := NULLIF(v_context->>'client_id', '')::UUID;
    v_context_sender := NULLIF(v_context->>'sender_id', '')::UUID;

    IF v_shipment_id IS NOT NULL THEN
        SELECT
            s.organization_id,
            s.client_id,
            s.sender_id,
            s.destination_address_id
        INTO v_org, v_client, v_sender, v_addr
        FROM public.shipments s
        WHERE s.id = v_shipment_id;
    ELSIF v_address_id IS NOT NULL THEN
        SELECT
            s.id,
            s.organization_id,
            s.client_id,
            s.sender_id,
            s.destination_address_id
        INTO v_shipment_id, v_org, v_client, v_sender, v_addr
        FROM public.shipments s
        WHERE s.destination_address_id = v_address_id
          AND (v_context_client IS NULL OR s.client_id = v_context_client)
        ORDER BY s.created_at DESC NULLS LAST
        LIMIT 1;
    END IF;

    IF v_source_id IS NOT NULL THEN
        SELECT
            ws.organization_id,
            s.client_id,
            ws.sender_id
        INTO v_source_org, v_source_client, v_source_sender
        FROM public.webhook_sources ws
        LEFT JOIN public.senders s ON s.id = ws.sender_id
        WHERE ws.id = v_source_id;

        IF v_source_org IS NULL THEN
            RAISE EXCEPTION 'geocoding_extract_context: webhook_source_id % not found', v_source_id
                USING ERRCODE = '23503';
        END IF;

        IF v_org IS NOT NULL AND v_source_org <> v_org THEN
            RAISE EXCEPTION 'geocoding_extract_context: source organization does not match workflow context'
                USING ERRCODE = '23514';
        END IF;
        IF v_sender IS NOT NULL AND v_source_sender IS NOT NULL AND v_source_sender <> v_sender THEN
            RAISE EXCEPTION 'geocoding_extract_context: source sender does not match shipment sender'
                USING ERRCODE = '23514';
        END IF;
        IF v_client IS NOT NULL AND v_source_client IS NOT NULL AND v_source_client <> v_client THEN
            RAISE EXCEPTION 'geocoding_extract_context: source client does not match shipment client'
                USING ERRCODE = '23514';
        END IF;
    END IF;

    v_org := COALESCE(v_org, v_context_org, v_source_org);
    v_client := COALESCE(v_client, v_context_client, v_source_client);
    v_sender := COALESCE(v_sender, v_context_sender, v_source_sender);
    v_addr := COALESCE(v_addr, v_address_id);

    RETURN QUERY
    SELECT
        v_org,
        v_client,
        v_sender,
        v_shipment_id,
        v_addr,
        v_source_id;
END;
$$;

COMMENT ON FUNCTION public.geocoding_extract_policy_context_v1(workflow_runs)
    IS 'Derives organization, client, sender, shipment, address, and webhook source identifiers from workflow context with source/sender/client consistency checks.';

CREATE OR REPLACE FUNCTION public.geocoding_resolve_policy(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID
)
RETURNS TABLE (
    policy JSONB,
    scope_type TEXT,
    scope_id UUID
)
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT *
    FROM public.geocoding_resolve_policy(
        p_organization_id,
        p_client_id,
        p_sender_id,
        NULL::UUID
    )
    LIMIT 1;
END;
$$;

CREATE OR REPLACE FUNCTION public.geocoding_resolve_policy(
    p_organization_id UUID,
    p_client_id UUID,
    p_sender_id UUID,
    p_webhook_source_id UUID
)
RETURNS TABLE (
    policy JSONB,
    scope_type TEXT,
    scope_id UUID
)
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $$
BEGIN
    RETURN QUERY
    SELECT
        r.value AS policy,
        r.scope_type,
        r.scope_id
    FROM public.resolve_settings_row_from_policy_context_v1(
        'geocoding_policy',
        jsonb_strip_nulls(jsonb_build_object(
            'organization_id', p_organization_id,
            'client_id', p_client_id,
            'sender_id', p_sender_id,
            'webhook_source_id', p_webhook_source_id
        ))
    ) r
    LIMIT 1;
END;
$$;

COMMENT ON FUNCTION public.geocoding_resolve_policy(UUID, UUID, UUID, UUID)
  IS 'Resolves geocoding_policy with policy-context precedence: source > sender > client > tenant > global.';

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(p_run workflow_runs)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_ctx RECORD;
  v_policy JSONB := NULL;
BEGIN
  SELECT * INTO v_ctx FROM public.geocoding_extract_policy_context_v1(p_run);

  SELECT r.value
    INTO v_policy
    FROM public.resolve_settings_row_from_policy_context_v1(
      'geocoding_policy',
      jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_ctx.organization_id,
        'client_id', v_ctx.client_id,
        'sender_id', v_ctx.sender_id,
        'webhook_source_id', v_ctx.webhook_source_id
      ))
    ) r
   LIMIT 1;

  RETURN COALESCE(v_policy, '{}'::jsonb);
END;
$$;

COMMENT ON FUNCTION workflow_handlers.geocoding_resolve_policy_for_run(workflow_runs)
  IS 'Resolves geocoding_policy for a workflow_run with source > sender > client > tenant > global precedence.';

CREATE OR REPLACE FUNCTION workflow_handlers.geocoding_log_match(
  p_run_id UUID,
  p_step_id UUID,
  p_policy JSONB,
  p_match JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_can_log BOOLEAN := COALESCE(p_policy->'logging'->>'log_scoring_details','false')::BOOLEAN;
  v_run workflow_runs%ROWTYPE;
  v_ctx RECORD;
  v_policy_record RECORD;
  v_settings_id UUID := NULL;
  v_settings_version_id UUID := NULL;
  v_version INT := NULL;
  v_scope_path JSONB := '[]'::jsonb;
  v_inputs JSONB := NULL;
  v_settings_resolution_id UUID := NULL;
BEGIN
  IF NOT v_can_log THEN
    RETURN;
  END IF;

  SELECT * INTO v_run FROM public.workflow_runs WHERE id = p_run_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT * INTO v_ctx FROM public.geocoding_extract_policy_context_v1(v_run);
  IF v_ctx.organization_id IS NULL THEN
    RETURN;
  END IF;

  v_scope_path := '[]'::jsonb;
  IF v_ctx.webhook_source_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('source'::text);
  END IF;
  IF v_ctx.sender_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('sender'::text);
  END IF;
  IF v_ctx.client_id IS NOT NULL THEN
    v_scope_path := v_scope_path || to_jsonb('client'::text);
  END IF;
  v_scope_path := v_scope_path || to_jsonb('tenant'::text);
  v_scope_path := v_scope_path || to_jsonb('global'::text);

  SELECT *
  INTO v_policy_record
  FROM public.geocoding_resolve_policy(
    v_ctx.organization_id,
    v_ctx.client_id,
    v_ctx.sender_id,
    v_ctx.webhook_source_id
  )
  LIMIT 1;

  IF v_policy_record.scope_type IS NULL THEN
    v_policy_record.scope_type := 'global';
    v_policy_record.scope_id := NULL;
  END IF;

  IF v_policy_record.scope_type IS NOT NULL THEN
    SELECT
      s.id AS settings_id,
      s.settings_version_id AS settings_version_id,
      sv.version AS version
    INTO v_settings_id, v_settings_version_id, v_version
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'geocoding_policy'
      AND s.scope_type = v_policy_record.scope_type
      AND s.scope_id IS NOT DISTINCT FROM v_policy_record.scope_id
    ORDER BY s.last_updated DESC
    LIMIT 1;
  END IF;

  IF v_settings_id IS NOT NULL THEN
    v_inputs := jsonb_strip_nulls(jsonb_build_object(
      'workflow_run_id', p_run_id,
      'workflow_step_id', p_step_id,
      'organization_id', v_ctx.organization_id,
      'client_id', v_ctx.client_id,
      'sender_id', v_ctx.sender_id,
      'webhook_source_id', v_ctx.webhook_source_id,
      'decision_point', COALESCE(p_match->>'plugin', 'geocoding'),
      'decision_outcome', COALESCE(p_match->>'match_type', 'unknown')
    ));

    v_settings_resolution_id := public.log_settings_resolution(
      p_organization_id := v_ctx.organization_id,
      p_category := 'geocoding_policy',
      p_winning_scope_type := v_policy_record.scope_type,
      p_winning_scope_id := v_policy_record.scope_id,
      p_winning_settings_id := v_settings_id,
      p_winning_settings_version_id := v_settings_version_id,
      p_winning_version := COALESCE(v_version, 1),
      p_scope_path := v_scope_path,
      p_inputs := v_inputs,
      p_merge_notes := NULL
    );
  END IF;

  INSERT INTO public.decision_log (
    organization_id,
    decision_category,
    resource_type,
    resource_id,
    decision_point,
    decision_outcome,
    decision_inputs,
    decision_reason,
    performed_by_system,
    correlation_id,
    settings_resolution_id
  )
  VALUES (
    v_ctx.organization_id,
    'geocoding',
    'workflow_run',
    p_run_id,
    COALESCE(p_match->>'plugin', 'geocoding'),
    COALESCE(p_match->>'match_type', 'unknown'),
    jsonb_strip_nulls(jsonb_build_object(
      'workflow_step_id', p_step_id,
      'address_id', v_ctx.address_id,
      'shipment_id', v_ctx.shipment_id,
      'client_id', v_ctx.client_id,
      'sender_id', v_ctx.sender_id,
      'webhook_source_id', v_ctx.webhook_source_id,
      'match', p_match
    )),
    'Geocoding match scored through row-driven geocoding_policy.',
    'workflow_handlers.geocoding_log_match',
    p_run_id,
    v_settings_resolution_id
  );
END;
$$;

DO $$
DECLARE
  v_function_sql TEXT;
  v_old_call TEXT := 'FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id
    )';
  v_new_call TEXT := 'FROM public.geocoding_resolve_policy(
        v_ctx.organization_id,
        v_ctx.client_id,
        v_ctx.sender_id,
        v_ctx.webhook_source_id
    )';
BEGIN
  SELECT pg_get_functiondef(
    'workflow_handlers.execute_provider_dispatch_v1(public.workflow_run_steps,public.workflow_runs,jsonb)'::regprocedure
  )
  INTO v_function_sql;

  IF v_function_sql IS NULL THEN
    RAISE EXCEPTION 'execute_provider_dispatch_v1 function definition not found';
  END IF;

  IF position(v_new_call IN v_function_sql) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old_call IN v_function_sql) = 0
     AND position('workflow_handlers.geocoding_resolve_policy_for_run(p_run)' IN v_function_sql) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old_call IN v_function_sql) = 0 THEN
    RAISE EXCEPTION 'execute_provider_dispatch_v1 source policy call shape changed; manual reapply required';
  END IF;

  v_function_sql := replace(
    v_function_sql,
    'geocoding_extract_context(p_run)',
    'public.geocoding_extract_policy_context_v1(p_run)'
  );
  v_function_sql := replace(
    v_function_sql,
    'geocoding_extract_context(wr)',
    'public.geocoding_extract_policy_context_v1(wr)'
  );
  v_function_sql := replace(v_function_sql, v_old_call, v_new_call);
  EXECUTE v_function_sql;
END $$;

COMMIT;
