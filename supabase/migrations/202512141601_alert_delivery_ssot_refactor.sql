-- Plan: PLAN-202512-logging-prod-ready-ssot-alert-delivery-v1 / Step: S01
-- Migration: Alert delivery SSOT refactor (channel-driven, operation_template-based)
-- Purpose:
--   - Make alert delivery fully row-driven and SSOT-aligned:
--       * channels come from alert_rules.alert_channels (source of truth)
--       * delivery config comes from resolve_settings('ops_oncall_alerting', scope ladder)
--       * HTTP request shape is defined in operation_templates/request_mappings (no channel-specific code)
--   - Ensure dispatch failures are never silent (decision_log + trigger context records)
-- Notes:
--   - Redaction/masking is deferred by decision; this migration focuses on structure/SSOT.

BEGIN;

-- ---------------------------------------------------------------------------
-- Helper: normalize destination string (config-driven)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.normalize_delivery_destination(
  p_raw TEXT,
  p_mode TEXT DEFAULT 'none'
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
  v_raw TEXT := NULLIF(COALESCE(p_raw, ''), '');
  v_mode TEXT := LOWER(COALESCE(NULLIF(p_mode, ''), 'none'));
BEGIN
  IF v_raw IS NULL THEN
    RETURN NULL;
  END IF;

  IF v_mode = 'digits_only' THEN
    RETURN NULLIF(regexp_replace(v_raw, '[^0-9]', '', 'g'), '');
  END IF;

  RETURN NULLIF(btrim(v_raw), '');
END;
$$;

COMMENT ON FUNCTION public.normalize_delivery_destination(TEXT, TEXT)
  IS 'Normalize a channel destination string using a config-defined mode (e.g., digits_only for WhatsApp).';

-- ---------------------------------------------------------------------------
-- Helper: enqueue outbound_calls from operation_templates (non-workflow context)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.enqueue_outbound_call_from_operation_template_v1(
  p_operation_template_id UUID,
  p_payload JSONB,
  p_job_context JSONB,
  p_correlation_id UUID,
  p_priority INT DEFAULT 90,
  p_max_retries INT DEFAULT 3,
  p_override_url TEXT DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_operation operation_templates%ROWTYPE;
  v_auth provider_auth_configs%ROWTYPE;
  v_mapping_scope JSONB;
  v_headers JSONB;
  v_body JSONB;
  v_call_type TEXT;
  v_target_url TEXT;
  v_outbound_id UUID;
BEGIN
  IF p_operation_template_id IS NULL THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: operation_template_id is required';
  END IF;

  SELECT *
  INTO v_operation
  FROM public.operation_templates
  WHERE id = p_operation_template_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: operation_template % not found', p_operation_template_id;
  END IF;

  SELECT *
  INTO v_auth
  FROM public.provider_auth_configs pac
  WHERE pac.provider_id = v_operation.provider_id
  ORDER BY pac.created_at DESC
  LIMIT 1;

  v_mapping_scope := jsonb_strip_nulls(jsonb_build_object(
    'context', COALESCE(p_job_context, '{}'::jsonb),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'operation', jsonb_build_object('id', v_operation.id, 'name', v_operation.operation_name),
    'provider_auth', CASE WHEN v_auth.id IS NOT NULL THEN jsonb_build_object('auth_type', v_auth.auth_type, 'credentials', v_auth.credentials) ELSE NULL END
  ));

  v_headers := apply_request_mappings(
    COALESCE(v_operation.headers_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'headers', '{}'::jsonb),
    v_mapping_scope
  );

  v_body := apply_request_mappings(
    COALESCE(v_operation.body_template, '{}'::jsonb),
    COALESCE(v_operation.request_mappings->'body', '{}'::jsonb),
    v_mapping_scope
  );

  v_call_type := COALESCE(NULLIF(v_operation.call_type, ''), 'provider_api');
  IF v_call_type NOT IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice') THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: unsupported call_type % for operation %', v_call_type, v_operation.id;
  END IF;

  v_target_url := COALESCE(NULLIF(p_override_url, ''), v_operation.url_template);
  IF v_target_url IS NULL OR btrim(v_target_url) = '' THEN
    RAISE EXCEPTION 'enqueue_outbound_call_from_operation_template_v1: url_template missing for operation %', v_operation.id;
  END IF;

  INSERT INTO public.outbound_calls (
    call_type,
    target_type,
    target_id,
    method,
    url,
    headers,
    body,
    priority,
    max_retries,
    context,
    correlation_id
  )
  VALUES (
    v_call_type,
    'provider',
    v_operation.provider_id,
    v_operation.method,
    v_target_url,
    v_headers,
    v_body,
    COALESCE(p_priority, 90),
    GREATEST(COALESCE(p_max_retries, 3), 1),
    jsonb_strip_nulls(COALESCE(p_job_context, '{}'::jsonb) || jsonb_build_object(
      'operation_template_id', v_operation.id,
      'operation_name', v_operation.operation_name
    )),
    p_correlation_id
  )
  RETURNING id INTO v_outbound_id;

  RETURN v_outbound_id;
END;
$$;

COMMENT ON FUNCTION public.enqueue_outbound_call_from_operation_template_v1(UUID, JSONB, JSONB, UUID, INT, INT, TEXT)
  IS 'Enqueue outbound_calls from operation_templates using apply_request_mappings (non-workflow contexts like ops dispatch).';

-- ---------------------------------------------------------------------------
-- Seed: operation_template for 360dialog WhatsApp on-call alert text send
-- (per provider row; unique(provider_id, operation_name))
-- ---------------------------------------------------------------------------
INSERT INTO public.operation_templates (
  provider_id,
  operation_name,
  handler_key,
  handler_version,
  call_type,
  method,
  url_template,
  headers_template,
  body_template,
  request_mappings,
  mapping_config_id,
  timeout_seconds,
  idempotency_key_template
)
SELECT
  p.id,
  'ops_oncall_whatsapp_alert_v1',
  'outbound_http',
  'v1',
  'comms_whatsapp',
  'POST',
  COALESCE(NULLIF(p.metadata->>'base_url', ''), 'https://waba-sandbox.360dialog.io') || '/v1/messages',
  jsonb_build_object('content-type', 'application/json'),
  jsonb_build_object(
    'messaging_product', 'whatsapp',
    'to', '',
    'type', 'text',
    'text', jsonb_build_object('body', '')
  ),
  jsonb_build_object(
    'headers', jsonb_build_object(
      'D360-API-KEY', '$.provider_auth.credentials.api_key'
    ),
    'body', jsonb_build_object(
      'to', '$.payload.to',
      'text.body', '$.payload.message'
    )
  ),
  '99990000-0000-0000-0000-000000210002'::uuid,
  30,
  NULL
FROM public.providers p
WHERE p.name = 'dialog360_whatsapp'
ON CONFLICT (provider_id, operation_name) DO UPDATE
SET
  handler_key = EXCLUDED.handler_key,
  handler_version = EXCLUDED.handler_version,
  call_type = EXCLUDED.call_type,
  method = EXCLUDED.method,
  url_template = EXCLUDED.url_template,
  headers_template = EXCLUDED.headers_template,
  body_template = EXCLUDED.body_template,
  request_mappings = EXCLUDED.request_mappings,
  mapping_config_id = EXCLUDED.mapping_config_id,
  timeout_seconds = EXCLUDED.timeout_seconds,
  updated_at = now();

-- ---------------------------------------------------------------------------
-- Worker: run_alert_dispatch_worker (SSOT + generic channel loop)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.run_alert_dispatch_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_throttle RECORD;
  v_context UUID;
  v_items_processed INT := 0;
  v_error_occurred BOOLEAN := FALSE;

  v_trigger RECORD;
  v_rule RECORD;

  v_policy JSONB;
  v_enabled BOOLEAN := FALSE;
  v_min_severity TEXT;
  v_min_rank INT := 0;
  v_alert_rank INT := 0;

  v_channels JSONB;
  v_channel TEXT;
  v_channel_cfg JSONB;

  v_to_raw TEXT;
  v_to_normalization TEXT;
  v_to TEXT;
  v_message_prefix TEXT;
  v_message TEXT;

  v_provider_id UUID;
  v_provider_name TEXT;
  v_operation_name TEXT;
  v_operation_template_id UUID;
  v_priority INT;
  v_max_retries INT;

  v_corr UUID;
  v_outbound_id UUID;
  v_dispatch_decision_id UUID;

  v_enqueued JSONB := '{}'::jsonb;
  v_skipped JSONB := '{}'::jsonb;
BEGIN
  SELECT * INTO v_throttle FROM public.check_throttle('alert_dispatch_worker');
  IF NOT v_throttle.should_run THEN
    RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
  END IF;

  v_context := public.create_request_context('alert_dispatch_worker');

  FOR v_trigger IN
    SELECT *
    FROM public.alert_triggers
    WHERE notified_at IS NULL
    ORDER BY "timestamp" ASC
    LIMIT v_throttle.batch_size
    FOR UPDATE SKIP LOCKED
  LOOP
    BEGIN
      SELECT *
      INTO v_rule
      FROM public.alert_rules
      WHERE id = v_trigger.alert_rule_id
      LIMIT 1;

      v_channels := COALESCE(v_rule.alert_channels, v_trigger.context->'alert_channels', '[]'::jsonb);
      IF jsonb_typeof(v_channels) <> 'array' THEN
        v_channels := '[]'::jsonb;
      END IF;

      -- Correlation from trigger context (preferred) otherwise NULL.
      v_corr := NULL;
      IF v_trigger.context ? 'correlation_id'
        AND (v_trigger.context->>'correlation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN
        v_corr := (v_trigger.context->>'correlation_id')::uuid;
      END IF;

      -- Resolve tenant/global on-call policy for this organization.
      v_policy := public.resolve_settings('ops_oncall_alerting', 'tenant', v_trigger.organization_id);
      v_enabled := FALSE;
      BEGIN
        v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
      EXCEPTION WHEN OTHERS THEN
        v_enabled := FALSE;
      END;

      IF NOT v_enabled THEN
        v_skipped := v_skipped || jsonb_build_object('policy', jsonb_build_object('reason', 'disabled'));
        UPDATE public.alert_triggers
        SET
          notified_at = now(),
          context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'dispatch', jsonb_build_object(
              'status', 'suppressed',
              'reason', 'policy_disabled',
              'worker_correlation_id', v_context,
              'processed_at', now()
            )
          ))
        WHERE id = v_trigger.id;
        v_items_processed := v_items_processed + 1;
        CONTINUE;
      END IF;

      v_min_severity := LOWER(COALESCE(NULLIF(v_policy->>'min_severity', ''), 'warning'));
      v_min_rank := CASE v_min_severity
        WHEN 'info' THEN 10
        WHEN 'warning' THEN 20
        WHEN 'error' THEN 30
        WHEN 'critical' THEN 40
        ELSE 20
      END;
      v_alert_rank := CASE LOWER(COALESCE(v_trigger.severity, ''))
        WHEN 'info' THEN 10
        WHEN 'warning' THEN 20
        WHEN 'error' THEN 30
        WHEN 'critical' THEN 40
        ELSE 0
      END;

      IF v_alert_rank < v_min_rank THEN
        UPDATE public.alert_triggers
        SET
          notified_at = now(),
          context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'dispatch', jsonb_build_object(
              'status', 'suppressed',
              'reason', 'below_min_severity',
              'min_severity', v_min_severity,
              'worker_correlation_id', v_context,
              'processed_at', now()
            )
          ))
        WHERE id = v_trigger.id;
        v_items_processed := v_items_processed + 1;
        CONTINUE;
      END IF;

      v_enqueued := '{}'::jsonb;
      v_skipped := '{}'::jsonb;

      FOR v_channel IN
        SELECT LOWER(value)
        FROM jsonb_array_elements_text(v_channels) a(value)
      LOOP
        v_channel_cfg := COALESCE(v_policy->'channels'->v_channel, v_policy->v_channel, '{}'::jsonb);
        IF jsonb_typeof(v_channel_cfg) <> 'object' THEN
          v_channel_cfg := '{}'::jsonb;
        END IF;

        -- If no config exists for this channel, record skip (no delivery path).
        IF v_channel_cfg = '{}'::jsonb THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'missing_channel_config'));
          CONTINUE;
        END IF;

        BEGIN
          IF COALESCE((v_channel_cfg->>'enabled')::BOOLEAN, TRUE) = FALSE THEN
            v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'channel_disabled'));
            CONTINUE;
          END IF;
        EXCEPTION WHEN OTHERS THEN
          -- Treat invalid enabled flag as enabled.
        END;

        v_to_raw := COALESCE(NULLIF(v_channel_cfg->>'to', ''), NULLIF(v_channel_cfg->>'to_phone', ''));
        v_to_normalization := COALESCE(NULLIF(v_channel_cfg->>'to_normalization', ''), 'none');
        v_to := public.normalize_delivery_destination(v_to_raw, v_to_normalization);
        IF v_to IS NULL THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'missing_destination'));
          CONTINUE;
        END IF;

        v_provider_id := NULL;
        IF v_channel_cfg ? 'provider_id'
          AND (v_channel_cfg->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        THEN
          v_provider_id := (v_channel_cfg->>'provider_id')::uuid;
        ELSE
          v_provider_name := NULLIF(v_channel_cfg->>'provider_name', '');
          IF v_provider_name IS NOT NULL THEN
            SELECT id
            INTO v_provider_id
            FROM public.providers
            WHERE organization_id = v_trigger.organization_id
              AND name = v_provider_name
            ORDER BY created_at DESC
            LIMIT 1;
          END IF;
        END IF;

        IF v_provider_id IS NULL THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'provider_not_resolved'));
          CONTINUE;
        END IF;

        IF NOT EXISTS (
          SELECT 1
          FROM public.providers p
          WHERE p.id = v_provider_id
            AND p.organization_id = v_trigger.organization_id
        ) THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'provider_not_in_org'));
          CONTINUE;
        END IF;

        v_operation_name := NULLIF(v_channel_cfg->>'operation_name', '');
        IF v_operation_name IS NULL THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'missing_operation_name'));
          CONTINUE;
        END IF;

        SELECT id
        INTO v_operation_template_id
        FROM public.operation_templates
        WHERE provider_id = v_provider_id
          AND operation_name = v_operation_name
        ORDER BY updated_at DESC
        LIMIT 1;

        IF v_operation_template_id IS NULL THEN
          v_skipped := v_skipped || jsonb_build_object(v_channel, jsonb_build_object('reason', 'operation_template_not_found', 'operation_name', v_operation_name));
          CONTINUE;
        END IF;

        BEGIN
          v_priority := COALESCE(NULLIF(v_channel_cfg->>'priority', '')::INT, 90);
        EXCEPTION WHEN OTHERS THEN
          v_priority := 90;
        END;
        BEGIN
          v_max_retries := COALESCE(NULLIF(v_channel_cfg->>'max_retries', '')::INT, 3);
        EXCEPTION WHEN OTHERS THEN
          v_max_retries := 3;
        END;

        v_message_prefix := COALESCE(NULLIF(v_channel_cfg->>'message_prefix', ''), '[ALERT]');
        v_message := format(
          '%s %s: %s (trigger=%s corr=%s)',
          v_message_prefix,
          COALESCE(NULLIF(v_rule.rule_name, ''), COALESCE(v_trigger.alert_rule_id::text, 'alert')),
          COALESCE(v_trigger.message, ''),
          v_trigger.id::text,
          COALESCE(v_corr::text, v_context::text)
        );

        v_outbound_id := public.enqueue_outbound_call_from_operation_template_v1(
          p_operation_template_id := v_operation_template_id,
          p_payload := jsonb_build_object('to', v_to, 'message', v_message),
          p_job_context := jsonb_strip_nulls(jsonb_build_object(
            'source', 'alert_dispatch_worker',
            'channel', v_channel,
            'to', v_to,
            'alert_trigger_id', v_trigger.id,
            'alert_rule_id', v_trigger.alert_rule_id,
            'severity', v_trigger.severity
          )),
          p_correlation_id := v_corr,
          p_priority := v_priority,
          p_max_retries := v_max_retries,
          p_override_url := NULL
        );

        v_dispatch_decision_id := public.log_decision(
          p_organization_id := v_trigger.organization_id,
          p_decision_category := 'alert_dispatch',
          p_resource_type := 'alert_trigger',
          p_resource_id := v_trigger.id,
          p_decision_point := 'enqueue_channel',
          p_decision_outcome := 'enqueued',
          p_performed_by_system := 'alert_dispatch_worker',
          p_correlation_id := COALESCE(v_corr, v_context),
          p_decision_inputs := jsonb_build_object(
            'channel', v_channel,
            'to', v_to,
            'outbound_call_id', v_outbound_id,
            'operation_template_id', v_operation_template_id
          ),
          p_decision_reason := 'Enqueued on-call alert delivery'
        );

        v_enqueued := v_enqueued || jsonb_build_object(v_channel, jsonb_build_object(
          'outbound_call_id', v_outbound_id,
          'decision_log_id', v_dispatch_decision_id
        ));
      END LOOP;

      UPDATE public.alert_triggers
      SET
        notified_at = now(),
        context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
          'dispatch', jsonb_build_object(
            'status', CASE WHEN v_enqueued = '{}'::jsonb THEN 'skipped' ELSE 'enqueued' END,
            'processed_at', now(),
            'worker_correlation_id', v_context,
            'channels', v_enqueued,
            'skipped', v_skipped
          )
        ))
      WHERE id = v_trigger.id;

      v_items_processed := v_items_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_error_occurred := TRUE;
      PERFORM public.log_decision(
        p_organization_id := v_trigger.organization_id,
        p_decision_category := 'alert_dispatch',
        p_resource_type := 'alert_trigger',
        p_resource_id := v_trigger.id,
        p_decision_point := 'dispatch_trigger',
        p_decision_outcome := 'error',
        p_performed_by_system := 'alert_dispatch_worker',
        p_correlation_id := COALESCE(v_corr, v_context),
        p_decision_inputs := jsonb_build_object('error', SQLERRM),
        p_decision_reason := SQLERRM
      );

      UPDATE public.alert_triggers
      SET
        notified_at = now(),
        context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
          'dispatch', jsonb_build_object(
            'status', 'error',
            'processed_at', now(),
            'worker_correlation_id', v_context,
            'error', SQLERRM
          )
        ))
      WHERE id = v_trigger.id;
    END;
  END LOOP;

  PERFORM public.complete_request_context(v_context, v_error_occurred, v_items_processed);
  PERFORM public.update_cron_config('alert_dispatch_worker');

  RETURN json_build_object(
    'status', 'completed',
    'items_processed', v_items_processed,
    'error_occurred', v_error_occurred
  );
END;
$$;

ALTER FUNCTION public.run_alert_dispatch_worker()
  SET search_path TO public, extensions, pg_temp;

COMMIT;
