-- Plan: PLAN-202512-ops-whatsapp-alerting-cron-health / Step: S01
-- Migration: Alert dispatch worker (WhatsApp on-call)
-- Purpose: Deliver durable alert_triggers to on-call via WhatsApp by enqueueing outbound_calls.
-- Notes:
--   - Fully row-driven: delivery config is resolved via resolve_settings('ops_oncall_alerting', tenant/global).
--   - No redaction/masking (deferred by decision).

BEGIN;

-- ---------------------------------------------------------------------------
-- Worker: run_alert_dispatch_worker
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
  v_org_slug TEXT;

  v_policy JSONB;
  v_whatsapp JSONB;

  v_enabled BOOLEAN := FALSE;
  v_whatsapp_enabled BOOLEAN := FALSE;
  v_min_severity TEXT;
  v_min_rank INT := 0;
  v_alert_rank INT := 0;

  v_provider_id UUID;
  v_provider_name TEXT;
  v_provider_base_url TEXT;
  v_url TEXT;
  v_url_path TEXT;
  v_api_key_header TEXT;
  v_api_key TEXT;
  v_to_phone TEXT;
  v_to_normalized TEXT;
  v_message_prefix TEXT;
  v_body_text TEXT;
  v_priority INT;
  v_max_retries INT;

  v_corr UUID;
  v_outbound_id UUID;
  v_dispatch_decision_id UUID;

  v_headers JSONB;
  v_body JSONB;
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
      -- Resolve tenant/global on-call policy for this organization.
      v_policy := public.resolve_settings('ops_oncall_alerting', 'tenant', v_trigger.organization_id);
      v_enabled := FALSE;
      BEGIN
        v_enabled := COALESCE((v_policy->>'enabled')::BOOLEAN, FALSE);
      EXCEPTION WHEN OTHERS THEN
        v_enabled := FALSE;
      END;

      IF NOT v_enabled THEN
        CONTINUE;
      END IF;

      v_whatsapp := COALESCE(v_policy->'whatsapp', '{}'::jsonb);
      v_whatsapp_enabled := TRUE;
      BEGIN
        v_whatsapp_enabled := COALESCE((v_whatsapp->>'enabled')::BOOLEAN, TRUE);
      EXCEPTION WHEN OTHERS THEN
        v_whatsapp_enabled := TRUE;
      END;
      IF NOT v_whatsapp_enabled THEN
        CONTINUE;
      END IF;

      v_min_severity := LOWER(COALESCE(NULLIF(v_whatsapp->>'min_severity', ''), NULLIF(v_policy->>'min_severity', ''), 'warning'));
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
        CONTINUE;
      END IF;

      v_to_phone := NULLIF(v_whatsapp->>'to_phone', '');
      IF v_to_phone IS NULL THEN
        CONTINUE;
      END IF;

      v_to_normalized := regexp_replace(v_to_phone, '[^0-9]', '', 'g');
      IF v_to_normalized IS NULL OR v_to_normalized = '' THEN
        CONTINUE;
      END IF;

      v_provider_id := NULL;
      v_provider_name := NULLIF(v_whatsapp->>'provider_name', '');
      IF v_whatsapp ? 'provider_id' AND (v_whatsapp->>'provider_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_provider_id := (v_whatsapp->>'provider_id')::uuid;
      ELSIF v_provider_name IS NOT NULL THEN
        SELECT id
        INTO v_provider_id
        FROM public.providers
        WHERE name = v_provider_name
        LIMIT 1;
      END IF;

      IF v_provider_id IS NULL THEN
        CONTINUE;
      END IF;

      v_api_key_header := COALESCE(NULLIF(v_whatsapp->>'api_key_header', ''), 'D360-API-KEY');
      SELECT pac.credentials->>'api_key'
      INTO v_api_key
      FROM public.provider_auth_configs pac
      WHERE pac.provider_id = v_provider_id
        AND pac.auth_type = 'api_key'
      ORDER BY pac.created_at DESC
      LIMIT 1;

      IF v_api_key IS NULL OR trim(v_api_key) = '' THEN
        CONTINUE;
      END IF;

      v_url := NULLIF(v_whatsapp->>'url', '');
      IF v_url IS NULL THEN
        v_url_path := COALESCE(NULLIF(v_whatsapp->>'url_path', ''), '/v1/messages');
        SELECT NULLIF(p.metadata->>'base_url', '')
        INTO v_provider_base_url
        FROM public.providers p
        WHERE p.id = v_provider_id
        LIMIT 1;

        IF v_provider_base_url IS NOT NULL THEN
          v_url := regexp_replace(v_provider_base_url, '/$', '') || v_url_path;
        END IF;
      END IF;

      IF v_url IS NULL THEN
        CONTINUE;
      END IF;

      v_priority := 100;
      BEGIN
        v_priority := COALESCE(NULLIF(v_whatsapp->>'priority', '')::INT, 100);
      EXCEPTION WHEN OTHERS THEN
        v_priority := 100;
      END;

      v_max_retries := 3;
      BEGIN
        v_max_retries := GREATEST(COALESCE(NULLIF(v_whatsapp->>'max_retries', '')::INT, 3), 1);
      EXCEPTION WHEN OTHERS THEN
        v_max_retries := 3;
      END;

      v_message_prefix := COALESCE(NULLIF(v_whatsapp->>'message_prefix', ''), '[MASARX]');

      SELECT ar.* INTO v_rule
      FROM public.alert_rules ar
      WHERE ar.id = v_trigger.alert_rule_id
      LIMIT 1;

      SELECT o.slug INTO v_org_slug
      FROM public.organizations o
      WHERE o.id = v_trigger.organization_id
      LIMIT 1;

      v_corr := NULL;
      IF v_trigger.context ? 'correlation_id'
        AND (v_trigger.context->>'correlation_id') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_corr := (v_trigger.context->>'correlation_id')::uuid;
      END IF;
      IF v_corr IS NULL THEN
        v_corr := v_context;
      END IF;

      -- Attach audit/trace correlation for this alert dispatch within the current transaction.
      PERFORM set_config('request.correlation_id', v_corr::text, true);

      v_body_text := format(
        '%s [%s] %s %s: %s (trigger=%s corr=%s)',
        v_message_prefix,
        COALESCE(v_org_slug, v_trigger.organization_id::text),
        UPPER(COALESCE(v_trigger.severity, 'alert')),
        COALESCE(v_rule.rule_name, v_trigger.alert_rule_id::text),
        COALESCE(v_trigger.message, ''),
        v_trigger.id::text,
        v_corr::text
      );

      v_headers := jsonb_strip_nulls(jsonb_build_object(
        'content-type', 'application/json',
        v_api_key_header, v_api_key
      ));

      v_body := jsonb_build_object(
        'messaging_product', COALESCE(NULLIF(v_whatsapp->>'messaging_product', ''), 'whatsapp'),
        'to', v_to_normalized,
        'type', 'text',
        'text', jsonb_build_object('body', v_body_text)
      );

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
        'comms_whatsapp',
        'provider',
        v_provider_id,
        'POST',
        v_url,
        v_headers,
        v_body,
        v_priority,
        v_max_retries,
        jsonb_strip_nulls(jsonb_build_object(
          'source', 'alert_dispatch_worker',
          'alert_trigger_id', v_trigger.id,
          'alert_rule_id', v_trigger.alert_rule_id,
          'severity', v_trigger.severity,
          'to_phone', v_to_normalized
        )),
        v_corr
      )
      RETURNING id INTO v_outbound_id;

      v_dispatch_decision_id := public.log_decision(
        p_organization_id := v_trigger.organization_id,
        p_decision_category := 'alert_dispatch',
        p_resource_type := 'alert_trigger',
        p_resource_id := v_trigger.id,
        p_decision_point := 'enqueue_whatsapp',
        p_decision_outcome := 'enqueued',
        p_performed_by_system := 'alert_dispatch_worker',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_build_object(
          'channel', 'whatsapp',
          'to_phone', v_to_normalized,
          'outbound_call_id', v_outbound_id,
          'alert_rule_id', v_trigger.alert_rule_id
        ),
        p_decision_reason := 'Enqueued WhatsApp on-call notification for alert trigger'
      );

      UPDATE public.alert_triggers
      SET
        notified_at = now(),
        context = jsonb_strip_nulls(
          COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'dispatch', jsonb_build_object(
              'channel', 'whatsapp',
              'outbound_call_id', v_outbound_id,
              'decision_log_id', v_dispatch_decision_id,
              'to_phone', v_to_normalized,
              'dispatched_at', now()
            )
          )
        )
      WHERE id = v_trigger.id;

      v_items_processed := v_items_processed + 1;
    EXCEPTION WHEN OTHERS THEN
      v_error_occurred := TRUE;
      CONTINUE;
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

-- ---------------------------------------------------------------------------
-- Worker registry + cron_config baseline
-- ---------------------------------------------------------------------------
INSERT INTO public.worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
  'alert_dispatch_worker',
  'monitoring',
  'Dispatch pending alert_triggers notifications (WhatsApp on-call) via outbound_calls.',
  '*/1 * * * *',
  jsonb_build_object('notes', 'Uses settings category ops_oncall_alerting; enqueues comms_whatsapp outbound_calls.'),
  TRUE
)
ON CONFLICT (worker_name) DO UPDATE
SET
  worker_type = EXCLUDED.worker_type,
  description = EXCLUDED.description,
  schedule = EXCLUDED.schedule,
  config = EXCLUDED.config,
  is_active = TRUE,
  updated_at = now();

INSERT INTO public.cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
  'alert_dispatch_worker',
  60,
  100,
  TRUE,
  'Dispatch alert_triggers to on-call WhatsApp (settings: ops_oncall_alerting)'
)
ON CONFLICT (worker_name) DO UPDATE
SET
  interval_seconds = EXCLUDED.interval_seconds,
  batch_size = EXCLUDED.batch_size,
  enabled = TRUE,
  notes = EXCLUDED.notes;

-- Optional: schedule via pg_cron (idempotent). Safe when ops_oncall_alerting is disabled/unset.
CREATE EXTENSION IF NOT EXISTS pg_cron WITH SCHEMA extensions;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM cron.job WHERE jobname = 'alert_dispatch_tick') THEN
    PERFORM cron.unschedule('alert_dispatch_tick');
  END IF;
END $$;

SELECT cron.schedule(
  'alert_dispatch_tick',
  '*/1 * * * *',
  $$SELECT public.run_alert_dispatch_worker();$$
);

COMMIT;

