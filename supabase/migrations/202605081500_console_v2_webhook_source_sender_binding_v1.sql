-- Console V2 webhook source sender/client binding.
--
-- Shipment-creation webhooks need a canonical sender so the receiver can
-- resolve the client and materialize shipments through the workflow engine.
-- Extend the existing source upsert RPC and directory projection without
-- introducing frontend-only defaults or direct table mutations.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605081500_console_v2_webhook_source_sender_binding_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_upsert_webhook_source_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_user_id UUID := auth.uid();
  v_org_id UUID := public.current_user_org_id();
  v_correlation_id UUID := gen_random_uuid();
  v_decision_id UUID := gen_random_uuid();
  v_resource_id UUID := NULLIF(p_args->>'source_id', '')::uuid;
  v_target_org UUID;
  v_source_identifier TEXT := NULLIF(btrim(COALESCE(p_args->>'source_identifier', '')), '');
  v_name TEXT := NULLIF(btrim(COALESCE(p_args->>'name', '')), '');
  v_provider_type TEXT := lower(NULLIF(btrim(COALESCE(p_args->>'provider_type', '')), ''));
  v_mapping_config_id UUID := NULLIF(p_args->>'mapping_config_id', '')::uuid;
  v_sender_id_present BOOLEAN := (p_args ? 'sender_id');
  v_sender_id UUID := NULLIF(p_args->>'sender_id', '')::uuid;
  v_sender_org UUID;
  v_rate_limit INTEGER := NULLIF(p_args->>'rate_limit_per_hour', '')::int;
  v_enabled_present BOOLEAN := (p_args ? 'enabled');
  v_enabled BOOLEAN := COALESCE((p_args->>'enabled')::boolean, TRUE);
  v_before public.webhook_sources%ROWTYPE;
  v_minted_token TEXT;
  v_action TEXT;
BEGIN
  IF v_user_id IS NULL THEN
    RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires authenticated user'
      USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('webhooks.write');

  IF v_resource_id IS NULL THEN
    IF v_source_identifier IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires source_identifier on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_name IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires name on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_provider_type IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires provider_type on create'
        USING ERRCODE = '23502';
    END IF;
    IF v_mapping_config_id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 requires mapping_config_id on create'
        USING ERRCODE = '23502';
    END IF;

    v_target_org := COALESCE(NULLIF(p_args->>'organization_id', '')::uuid, v_org_id);
    IF v_target_org IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 cannot resolve target organization'
        USING ERRCODE = '23502';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_target_org <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 organization_id outside tenant scope'
        USING ERRCODE = '42501';
    END IF;

    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_minted_token := encode(gen_random_bytes(32), 'hex');

    INSERT INTO public.webhook_sources (
      organization_id, source_identifier, name, provider_type,
      auth_token, mapping_config_id, sender_id, rate_limit_per_hour, enabled
    ) VALUES (
      v_target_org, v_source_identifier, v_name, v_provider_type,
      v_minted_token, v_mapping_config_id, v_sender_id, COALESCE(v_rate_limit, 1000), v_enabled
    )
    RETURNING id INTO v_resource_id;

    v_action := 'created';
  ELSE
    SELECT * INTO v_before FROM public.webhook_sources WHERE id = v_resource_id FOR UPDATE;
    IF v_before.id IS NULL THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % not found', v_resource_id
        USING ERRCODE = '23503';
    END IF;
    IF v_org_id IS NOT NULL
       AND v_before.organization_id <> v_org_id
       AND NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_upsert_webhook_source_v1 webhook_source % outside tenant scope', v_resource_id
        USING ERRCODE = '42501';
    END IF;

    v_target_org := v_before.organization_id;

    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    UPDATE public.webhook_sources
       SET source_identifier = COALESCE(v_source_identifier, source_identifier),
           name = COALESCE(v_name, name),
           provider_type = COALESCE(v_provider_type, provider_type),
           mapping_config_id = COALESCE(v_mapping_config_id, mapping_config_id),
           sender_id = CASE WHEN v_sender_id_present THEN v_sender_id ELSE sender_id END,
           rate_limit_per_hour = COALESCE(v_rate_limit, rate_limit_per_hour),
           enabled = CASE WHEN v_enabled_present THEN v_enabled ELSE enabled END,
           updated_at = now()
     WHERE id = v_resource_id;

    v_action := 'updated';
  END IF;

  INSERT INTO public.decision_log (
    id, organization_id, decision_category, resource_type, resource_id,
    decision_point, decision_outcome, decision_inputs, performed_by_system, correlation_id
  ) VALUES (
    v_decision_id, COALESCE(v_target_org, '00000000-0000-0000-0000-000000000000'::uuid),
    'webhooks.upsert_source', 'webhook_source', v_resource_id,
    'ui_upsert_webhook_source_v1', v_action,
    jsonb_strip_nulls(jsonb_build_object(
      'source_identifier', v_source_identifier,
      'name', v_name,
      'provider_type', v_provider_type,
      'mapping_config_id', v_mapping_config_id,
      'sender_id', CASE WHEN v_sender_id_present THEN to_jsonb(v_sender_id) ELSE NULL END,
      'rate_limit_per_hour', v_rate_limit,
      'enabled', CASE WHEN v_enabled_present THEN to_jsonb(v_enabled) ELSE NULL END
    )),
    'ui_upsert_webhook_source_v1', v_correlation_id
  );

  IF v_target_org IS NOT NULL THEN
    INSERT INTO public.domain_events (
      organization_id, event_type, resource_type, resource_id, payload, correlation_id, status
    ) VALUES (
      v_target_org, 'webhook_source.' || v_action, 'webhook_source', v_resource_id,
      jsonb_strip_nulls(jsonb_build_object(
        'source_identifier', v_source_identifier,
        'name', v_name,
        'provider_type', v_provider_type,
        'sender_id', CASE WHEN v_sender_id_present THEN to_jsonb(v_sender_id) ELSE NULL END
      )),
      v_correlation_id, 'pending'
    );
  END IF;

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', true,
    'webhook_source_id', v_resource_id,
    'action', v_action,
    'auth_token', v_minted_token,
    'correlation_id', v_correlation_id,
    'settings_resolution_id', v_decision_id
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb) TO authenticated, service_role;

COMMENT ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb)
  IS 'Canonical write RPC: insert/update public.webhook_sources, including optional sender_id binding used by shipment-creation webhooks. Capability: webhooks.write. On create, mints fresh auth_token returned once.';

CREATE OR REPLACE VIEW public.v_webhook_source_directory
  WITH (security_invoker = true)
  AS
SELECT
  ws.id,
  ws.organization_id,
  ws.source_identifier,
  ws.name,
  ws.provider_type,
  ws.auth_token,
  ws.mapping_config_id,
  ws.rate_limit_per_hour,
  ws.enabled,
  ws.created_at,
  ws.updated_at,
  mc.mapping_key AS mapping_label,
  inbox_agg.last_event_at,
  inbox_agg.last_event_status,
  COALESCE(inbox_agg.event_count_24h, 0) AS event_count_24h,
  COALESCE(inbox_agg.error_count_24h, 0) AS error_count_24h,
  COALESCE(rule_agg.rule_count, 0) AS rule_count,
  COALESCE(rule_agg.active_rule_count, 0) AS active_rule_count,
  (ws.enabled = TRUE AND COALESCE(inbox_agg.error_count_24h, 0) = 0) AS is_healthy,
  (COALESCE(inbox_agg.error_count_24h, 0) > 0) AS has_recent_errors,
  CASE
    WHEN ws.auth_token IS NOT NULL AND length(ws.auth_token) <= 4 THEN 'stored'
    WHEN ws.auth_token IS NOT NULL THEN substring(ws.auth_token FROM 1 FOR 4) || '-stored'
    WHEN ws.auth_token_hash IS NOT NULL THEN 'stored'
    ELSE NULL
  END AS auth_token_masked,
  ws.sender_id,
  snd.client_id,
  snd.name AS sender_label,
  c.name AS client_label
FROM public.webhook_sources ws
LEFT JOIN public.mapping_configs mc ON mc.id = ws.mapping_config_id
LEFT JOIN public.senders snd ON snd.id = ws.sender_id
LEFT JOIN public.clients c ON c.id = snd.client_id
LEFT JOIN LATERAL (
  SELECT
    MAX(wi.created_at) AS last_event_at,
    (
      SELECT processing_status
        FROM public.webhook_inbox wi2
       WHERE wi2.webhook_source_id = ws.id
       ORDER BY wi2.created_at DESC
       LIMIT 1
    ) AS last_event_status,
    COUNT(*) FILTER (WHERE wi.created_at > now() - INTERVAL '24 hours') AS event_count_24h,
    COUNT(*) FILTER (
      WHERE wi.created_at > now() - INTERVAL '24 hours'
        AND wi.processing_status IN ('failed', 'dead_letter')
    ) AS error_count_24h
    FROM public.webhook_inbox wi
   WHERE wi.webhook_source_id = ws.id
) inbox_agg ON TRUE
LEFT JOIN LATERAL (
  SELECT
    COUNT(*) AS rule_count,
    COUNT(*) FILTER (WHERE wr.enabled = TRUE) AS active_rule_count
    FROM public.webhook_rules wr
   WHERE wr.webhook_source_id = ws.id
) rule_agg ON TRUE;

COMMENT ON VIEW public.v_webhook_source_directory IS
  'FE-friendly projection of webhook_sources with derived counters, mapping label, token status, and optional sender/client binding used by shipment-creation webhook intake. Sources: webhook_sources + webhook_inbox + webhook_rules + mapping_configs + senders + clients. Read-only; mutations go through ui_upsert_webhook_source_v1 / ui_rotate_webhook_source_token_v1.';

REVOKE ALL ON public.v_webhook_source_directory FROM PUBLIC;
REVOKE ALL ON public.v_webhook_source_directory FROM anon;
GRANT SELECT ON public.v_webhook_source_directory TO authenticated;
GRANT SELECT ON public.v_webhook_source_directory TO service_role;

SELECT pg_advisory_unlock(hashtext('202605081500_console_v2_webhook_source_sender_binding_v1'));

COMMIT;
