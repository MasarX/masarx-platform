-- Migration: Alert triggers + dispatch workers (queue-only, no direct network)
-- Purpose:
--   - Make alert_rules actionable by creating alert_triggers for matches.
--   - Dispatch alerts by enqueueing outbound_calls (WhatsApp via dialog360) using row-driven configuration.
-- Date: 2025-12-13

BEGIN;

CREATE OR REPLACE FUNCTION public.run_alert_aggregation_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_items_processed INT := 0;
    v_rule RECORD;
    v_trigger_category TEXT;
    v_trigger_outcome TEXT;
    v_trigger_point TEXT;
    v_view_name TEXT;
    v_match_count INT := 0;
    v_outcome TEXT := 'no_alert';
    v_window_minutes INT;
    v_window_interval INTERVAL;
    v_reason TEXT := 'Alert rule evaluated';
    v_threshold INT := 0;
    v_comparison TEXT := '>';
    v_should_trigger BOOLEAN := FALSE;
    v_severity TEXT := 'warning';
    v_trigger_id UUID := NULL;
    v_message TEXT := NULL;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('alert_aggregation_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('alert_aggregation_worker');

    FOR v_rule IN
        SELECT *
        FROM alert_rules
        WHERE enabled = TRUE
        ORDER BY priority DESC
        LIMIT v_throttle.batch_size
    LOOP
        v_window_minutes := GREATEST(COALESCE(v_rule.throttle_window_minutes, 15), 1);
        v_window_interval := make_interval(mins => v_window_minutes);
        v_match_count := 0;
        v_trigger_id := NULL;
        v_message := NULL;
        v_outcome := 'no_alert';
        v_reason := 'Alert rule evaluated';
        v_trigger_category := NULL;
        v_trigger_outcome := NULL;
        v_trigger_point := NULL;
        v_view_name := NULL;
        v_threshold := 0;
        v_comparison := '>';
        v_should_trigger := FALSE;

        SELECT COALESCE(lv.value, 'warning')
          INTO v_severity
          FROM lookup_values lv
         WHERE lv.id = v_rule.alert_severity_lookup_id;
        v_severity := COALESCE(v_severity, 'warning');

        IF v_rule.trigger_source = 'decision_log' THEN
            v_trigger_category := NULLIF(v_rule.trigger_conditions->>'decision_category', '');
            v_trigger_outcome := NULLIF(v_rule.trigger_conditions->>'decision_outcome', '');
            v_trigger_point := NULLIF(v_rule.trigger_conditions->>'decision_point', '');

            IF v_trigger_category IS NULL THEN
                v_outcome := 'missing_trigger_category';
                v_reason := 'trigger_conditions.decision_category not present; rule ignored';
            ELSE
                SELECT COUNT(*)
                  INTO v_match_count
                  FROM decision_log
                 WHERE decision_category = v_trigger_category
                   AND (v_trigger_outcome IS NULL OR decision_outcome = v_trigger_outcome)
                   AND (v_trigger_point IS NULL OR decision_point = v_trigger_point)
                   AND timestamp > now() - v_window_interval
                   AND organization_id = v_rule.organization_id;
            END IF;
        ELSIF v_rule.trigger_source = 'sql_view' THEN
            v_view_name := NULLIF(v_rule.trigger_conditions->>'view', '');
            v_threshold := COALESCE(NULLIF(v_rule.trigger_conditions->>'threshold', '')::INT, 0);
            v_comparison := COALESCE(NULLIF(v_rule.trigger_conditions->>'comparison', ''), '>');
            v_window_minutes := GREATEST(
              COALESCE(NULLIF(v_rule.trigger_conditions->>'window_minutes', '')::INT, v_window_minutes),
              1
            );
            v_window_interval := make_interval(mins => v_window_minutes);

            IF v_view_name IS NULL THEN
                v_outcome := 'missing_view';
                v_reason := 'trigger_conditions.view not present; rule ignored';
            ELSE
                BEGIN
                    EXECUTE format(
                        'SELECT COUNT(*) FROM public.%I WHERE organization_id = $1 AND decision_time >= now() - make_interval(mins => $2)',
                        v_view_name
                    )
                    INTO v_match_count
                    USING v_rule.organization_id, v_window_minutes;
                EXCEPTION
                    WHEN others THEN
                        v_outcome := 'sql_view_error';
                        v_reason := SQLERRM;
                END;
            END IF;
        ELSE
            v_outcome := 'unsupported_trigger_source';
            v_reason := format('Trigger source %s not yet supported by alert worker', v_rule.trigger_source);
        END IF;

        IF v_outcome NOT IN ('unsupported_trigger_source', 'missing_trigger_category', 'missing_view', 'sql_view_error') THEN
            v_should_trigger := CASE v_comparison
                WHEN '>' THEN v_match_count > v_threshold
                WHEN '>=' THEN v_match_count >= v_threshold
                WHEN '=' THEN v_match_count = v_threshold
                WHEN '<' THEN v_match_count < v_threshold
                WHEN '<=' THEN v_match_count <= v_threshold
                ELSE v_match_count > v_threshold
            END;

            IF v_should_trigger THEN
                IF EXISTS (
                    SELECT 1
                    FROM alert_triggers t
                    WHERE t.alert_rule_id = v_rule.id
                      AND t.organization_id = v_rule.organization_id
                      AND t.timestamp > now() - v_window_interval
                      AND t.acknowledged_at IS NULL
                ) THEN
                    v_outcome := 'alert_suppressed';
                    v_reason := format('Alert suppressed; existing unacknowledged trigger in last %s minutes', v_window_minutes);
                ELSE
                    v_message := NULLIF(v_rule.message_variables->>'message', '');
                    IF v_message IS NULL THEN
                        IF v_rule.trigger_source = 'sql_view' AND v_view_name IS NOT NULL THEN
                            v_message := format('%s: %s match(es) in last %s minutes (view=%s)', v_rule.rule_name, v_match_count, v_window_minutes, v_view_name);
                        ELSE
                            v_message := format('%s: %s match(es) in last %s minutes', v_rule.rule_name, v_match_count, v_window_minutes);
                        END IF;
                    END IF;

                    INSERT INTO alert_triggers (
                        alert_rule_id,
                        organization_id,
                        resource_type,
                        resource_id,
                        severity,
                        message,
                        context
                    )
                    VALUES (
                        v_rule.id,
                        v_rule.organization_id,
                        'alert_rule',
                        v_rule.id,
                        v_severity,
                        v_message,
                        jsonb_strip_nulls(jsonb_build_object(
                            'trigger_source', v_rule.trigger_source,
                            'trigger_conditions', v_rule.trigger_conditions,
                            'match_count', v_match_count,
                            'window_minutes', v_window_minutes
                        ))
                    )
                    RETURNING id INTO v_trigger_id;

                    v_outcome := 'alert_triggered';
                    v_reason := format('Alert triggered (%s matches in last %s minutes)', v_match_count, v_window_minutes);
                END IF;
            ELSE
                v_outcome := 'no_alert';
                v_reason := format('No trigger condition met (count=%s threshold=%s comparison=%s)', v_match_count, v_threshold, v_comparison);
            END IF;
        END IF;

        PERFORM log_decision(
            p_organization_id := v_rule.organization_id,
            p_decision_category := 'alert_evaluation',
            p_resource_type := 'alert_rule',
            p_resource_id := v_rule.id,
            p_decision_point := 'rule_scan',
            p_decision_outcome := v_outcome,
            p_performed_by_system := 'alert_aggregation_worker',
            p_correlation_id := v_context,
            p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                'trigger_id', v_trigger_id,
                'trigger_source', v_rule.trigger_source,
                'trigger_category', v_trigger_category,
                'view', v_view_name,
                'match_count', v_match_count,
                'window_minutes', v_window_minutes,
                'threshold', v_threshold,
                'comparison', v_comparison
            )),
            p_decision_reason := v_reason
        );
        v_items_processed := v_items_processed + 1;
    END LOOP;

    PERFORM complete_request_context(v_context, FALSE, v_items_processed);
    PERFORM update_cron_config('alert_aggregation_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', FALSE
    );
END;
$$;

CREATE OR REPLACE FUNCTION public.dispatch_alert_trigger(p_trigger_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_trigger RECORD;
  v_rule RECORD;
  v_channel TEXT;
  v_dispatch_auth UUID;
  v_policy JSONB;
  v_provider_id UUID;
  v_default_recipient TEXT;
  v_recipients JSONB;
  v_recipient TEXT;
  v_enqueued INT := 0;
  v_result JSONB;
BEGIN
  SELECT * INTO v_trigger FROM alert_triggers WHERE id = p_trigger_id;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('status', 'missing', 'reason', 'trigger_not_found');
  END IF;

  IF v_trigger.notified_at IS NOT NULL THEN
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'already_notified');
  END IF;

  SELECT * INTO v_rule FROM alert_rules WHERE id = v_trigger.alert_rule_id;
  IF NOT FOUND THEN
    UPDATE alert_triggers
       SET notified_at = now(),
           resolution_notes = COALESCE(resolution_notes, 'dispatch_skipped_missing_rule')
     WHERE id = v_trigger.id;
    RETURN jsonb_build_object('status', 'skipped', 'reason', 'rule_not_found');
  END IF;

  -- Optional per-rule overrides.
  v_dispatch_auth := NULLIF(v_rule.message_variables #>> '{dispatch,auth_config_id}', '')::UUID;
  v_recipients := v_rule.message_variables #> '{dispatch,recipients}';

  -- Fallback: derive auth_config_id from comms reply policy (tenant -> global).
  IF v_dispatch_auth IS NULL THEN
    v_policy := resolve_settings('comms_reply_policy', 'tenant', v_trigger.organization_id);
    IF v_policy IS NULL THEN
      v_policy := resolve_settings('comms_reply_policy', 'global', NULL);
    END IF;
    v_dispatch_auth := NULLIF(v_policy->>'auth_config_id', '')::UUID;
  END IF;

  IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array' OR jsonb_array_length(v_recipients) = 0 THEN
    -- Fallback: use provider_defaults.default_recipient for the provider behind auth_config_id.
    IF v_dispatch_auth IS NOT NULL THEN
      SELECT provider_id INTO v_provider_id FROM provider_auth_configs WHERE id = v_dispatch_auth;
      IF v_provider_id IS NOT NULL THEN
        SELECT NULLIF(cached_value->>'default_recipient', '')
          INTO v_default_recipient
          FROM settings
         WHERE category = 'provider_defaults'
           AND scope_type = 'resource'
           AND scope_id = v_provider_id
         ORDER BY last_updated DESC NULLS LAST
         LIMIT 1;
      END IF;
    END IF;
    IF v_default_recipient IS NOT NULL THEN
      v_recipients := jsonb_build_array(v_default_recipient);
    END IF;
  END IF;

  -- Only support WhatsApp dispatch for now (queue-only; no direct network calls).
  FOR v_channel IN
    SELECT jsonb_array_elements_text(COALESCE(v_rule.alert_channels, '[]'::jsonb))
  LOOP
    IF v_channel <> 'comms_whatsapp' THEN
      CONTINUE;
    END IF;

    IF v_dispatch_auth IS NULL THEN
      CONTINUE;
    END IF;

    IF v_recipients IS NULL OR jsonb_typeof(v_recipients) <> 'array' OR jsonb_array_length(v_recipients) = 0 THEN
      CONTINUE;
    END IF;

    FOR v_recipient IN
      SELECT jsonb_array_elements_text(v_recipients)
    LOOP
      BEGIN
        PERFORM public.enqueue_comms_whatsapp(
          v_dispatch_auth,
          v_recipient,
          v_trigger.message,
          v_trigger.id,
          NULL,
          jsonb_strip_nulls(jsonb_build_object(
            'source', 'dispatch_alert_trigger',
            'alert_trigger_id', v_trigger.id,
            'alert_rule_id', v_rule.id,
            'severity', v_trigger.severity
          ))
        );
        v_enqueued := v_enqueued + 1;
      EXCEPTION
        WHEN others THEN
          -- Continue dispatch attempts for other recipients/channels.
          CONTINUE;
      END;
    END LOOP;
  END LOOP;

  IF v_enqueued > 0 THEN
    UPDATE alert_triggers
       SET notified_at = now()
     WHERE id = v_trigger.id;
    v_result := jsonb_build_object('status', 'dispatched', 'enqueued', v_enqueued);
  ELSE
    UPDATE alert_triggers
       SET notified_at = now(),
           resolution_notes = COALESCE(resolution_notes, 'dispatch_skipped_missing_config')
     WHERE id = v_trigger.id;
    v_result := jsonb_build_object('status', 'skipped', 'reason', 'no_dispatch_targets');
  END IF;

  PERFORM log_decision(
    p_organization_id := v_trigger.organization_id,
    p_decision_category := 'alert_dispatch',
    p_resource_type := 'alert_trigger',
    p_resource_id := v_trigger.id,
    p_decision_point := 'dispatch',
    p_decision_outcome := v_result->>'status',
    p_performed_by_system := 'alert_dispatch_worker',
    p_correlation_id := v_trigger.id,
    p_decision_inputs := jsonb_strip_nulls(jsonb_build_object('enqueued', v_enqueued)),
    p_decision_reason := COALESCE(v_result->>'reason', NULL)
  );

  RETURN v_result;
END;
$$;

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
    v_row RECORD;
    v_error BOOLEAN := FALSE;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('alert_dispatch_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('alert_dispatch_worker');

    FOR v_row IN
        SELECT id
        FROM alert_triggers
        WHERE notified_at IS NULL
        ORDER BY timestamp ASC
        LIMIT v_throttle.batch_size
    LOOP
        BEGIN
            PERFORM public.dispatch_alert_trigger(v_row.id);
            v_items_processed := v_items_processed + 1;
        EXCEPTION
            WHEN others THEN
                v_error := TRUE;
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_items_processed);
    PERFORM update_cron_config('alert_dispatch_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_items_processed,
        'error_occurred', v_error
    );
END;
$$;

-- Align comms_reply_failures rule with supported trigger evaluation and dispatch channel.
DO $$
DECLARE
  v_org UUID;
BEGIN
  SELECT id INTO v_org FROM organizations ORDER BY created_at LIMIT 1;
  IF v_org IS NULL THEN
    RETURN;
  END IF;

  UPDATE alert_rules
     SET trigger_source = 'sql_view',
         trigger_conditions = jsonb_build_object(
           'view', 'comms_reply_failures_v',
           'window_minutes', 5,
           'threshold', 0,
           'comparison', '>'
         ),
         alert_channels = jsonb_build_array('comms_whatsapp'),
         updated_at = now()
   WHERE rule_name = 'comms_reply_failures';
END;
$$;

COMMIT;
