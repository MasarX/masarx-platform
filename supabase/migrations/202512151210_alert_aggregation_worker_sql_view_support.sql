-- Plan: PLAN-202512-cloud-migrations-uniqueness-ci-alignment / Step: S02
-- Migration: Add sql_view support to alert_aggregation_worker
-- Purpose: Enable row-driven alert_rules(trigger_source=sql_view) to emit alert_triggers using safe, schema-validated view evaluation.

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
    v_match_count INT := 0;
    v_outcome TEXT := 'no_alert';
    v_window_minutes INT;
    v_window_interval INTERVAL;
    v_reason TEXT := 'Alert rule evaluated';

    v_aggr JSONB;
    v_aggr_fn TEXT;
    v_aggr_window_minutes INT;
    v_having JSONB;
    v_having_op TEXT;
    v_having_val INT;
    v_threshold_met BOOLEAN := FALSE;
    v_latest_decision_id UUID;
    v_latest_corr UUID;

    v_view_name TEXT;
    v_view_threshold INT;
    v_view_comparison TEXT;
    v_view_sql TEXT;
    v_view_has_org BOOLEAN;
    v_view_has_time BOOLEAN;

    v_severity TEXT;
    v_message TEXT;
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
        v_trigger_category := v_rule.trigger_conditions->>'decision_category';
        v_trigger_outcome := NULLIF(v_rule.trigger_conditions->>'decision_outcome', '');
        v_aggr := v_rule.trigger_conditions->'$aggregate';
        v_aggr_fn := COALESCE(v_aggr->>'function', '');
        v_aggr_window_minutes := NULLIF(v_aggr->>'window_minutes', '')::INT;
        v_having := v_aggr->'having';

        v_window_minutes := GREATEST(COALESCE(v_aggr_window_minutes, v_rule.throttle_window_minutes, 15), 1);
        v_window_interval := make_interval(mins => v_window_minutes);
        v_match_count := 0;
        v_outcome := 'no_alert';
        v_reason := 'Alert rule evaluated';
        v_threshold_met := FALSE;
        v_latest_decision_id := NULL;
        v_latest_corr := NULL;

        IF v_rule.trigger_source = 'decision_log' THEN
            IF v_trigger_category IS NOT NULL THEN
                SELECT COUNT(*)
                INTO v_match_count
                FROM decision_log
                WHERE decision_category = v_trigger_category
                  AND timestamp > now() - v_window_interval
                  AND organization_id = v_rule.organization_id
                  AND (v_trigger_outcome IS NULL OR decision_outcome = v_trigger_outcome);

                -- Default: any match triggers.
                v_threshold_met := v_match_count > 0;

                -- Optional aggregation threshold (count only for now).
                IF v_aggr IS NOT NULL AND jsonb_typeof(v_aggr) = 'object' THEN
                    IF v_aggr_fn <> '' AND v_aggr_fn <> 'count' THEN
                        v_outcome := 'unsupported_aggregate_function';
                        v_reason := format('Unsupported aggregate function %s; treated as any-match', v_aggr_fn);
                    ELSIF v_having IS NOT NULL AND jsonb_typeof(v_having) = 'object' THEN
                        SELECT key, value::INT
                        INTO v_having_op, v_having_val
                        FROM jsonb_each(v_having)
                        LIMIT 1;

                        IF v_having_op = '>' THEN
                            v_threshold_met := v_match_count > v_having_val;
                        ELSIF v_having_op = '>=' THEN
                            v_threshold_met := v_match_count >= v_having_val;
                        ELSIF v_having_op = '<' THEN
                            v_threshold_met := v_match_count < v_having_val;
                        ELSIF v_having_op = '<=' THEN
                            v_threshold_met := v_match_count <= v_having_val;
                        ELSIF v_having_op = '=' THEN
                            v_threshold_met := v_match_count = v_having_val;
                        ELSE
                            v_threshold_met := v_match_count > 0;
                        END IF;
                    END IF;
                END IF;

                IF v_threshold_met THEN
                    v_outcome := 'alert_triggered';
                    v_reason := format('Alert triggered (%s matches in last %s minutes)', v_match_count, v_window_minutes);

                    SELECT id, correlation_id
                    INTO v_latest_decision_id, v_latest_corr
                    FROM decision_log
                    WHERE decision_category = v_trigger_category
                      AND timestamp > now() - v_window_interval
                      AND organization_id = v_rule.organization_id
                      AND (v_trigger_outcome IS NULL OR decision_outcome = v_trigger_outcome)
                    ORDER BY timestamp DESC
                    LIMIT 1;

                    v_severity := COALESCE(
                        (SELECT lv.value FROM lookup_values lv WHERE lv.id = v_rule.alert_severity_lookup_id LIMIT 1),
                        'warning'
                    );
                    v_message := COALESCE(v_rule.rule_name, 'alert') || ': ' || v_reason;

                    -- Durable trigger record (throttled by rule + window + latest matching decision).
                    IF v_latest_decision_id IS NOT NULL THEN
                        IF NOT EXISTS (
                            SELECT 1
                            FROM alert_triggers atr
                            WHERE atr.alert_rule_id = v_rule.id
                              AND atr.resource_type = 'decision_log'
                              AND atr.resource_id = v_latest_decision_id
                              AND atr.timestamp > now() - v_window_interval
                            LIMIT 1
                        ) THEN
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
                                'decision_log',
                                v_latest_decision_id,
                                v_severity,
                                v_message,
                                jsonb_strip_nulls(jsonb_build_object(
                                    'match_count', v_match_count,
                                    'window_minutes', v_window_minutes,
                                    'decision_category', v_trigger_category,
                                    'decision_outcome', v_trigger_outcome,
                                    'correlation_id', v_latest_corr,
                                    'alert_channels', v_rule.alert_channels
                                ))
                            );
                        END IF;
                    END IF;
                ELSE
                    v_reason := format('No breach for %s in last %s minutes (matches=%s)', v_trigger_category, v_window_minutes, v_match_count);
                END IF;
            ELSE
                v_outcome := 'missing_trigger_category';
                v_reason := 'trigger_conditions.decision_category not present; rule ignored';
            END IF;

        ELSIF v_rule.trigger_source = 'sql_view' THEN
            v_view_name := NULLIF(v_rule.trigger_conditions->>'view', '');
            v_view_threshold := COALESCE(NULLIF(v_rule.trigger_conditions->>'threshold', '')::INT, 0);
            v_view_comparison := COALESCE(NULLIF(v_rule.trigger_conditions->>'comparison', ''), '>');

            v_window_minutes := GREATEST(
              COALESCE(NULLIF(v_rule.trigger_conditions->>'window_minutes', '')::INT, v_rule.throttle_window_minutes, 15),
              1
            );
            v_window_interval := make_interval(mins => v_window_minutes);

            IF v_view_name IS NULL THEN
                v_outcome := 'missing_sql_view';
                v_reason := 'trigger_conditions.view not present; rule ignored';
            ELSIF NOT EXISTS (
                SELECT 1
                FROM information_schema.views
                WHERE table_schema = 'public'
                  AND table_name = v_view_name
            ) THEN
                v_outcome := 'missing_sql_view';
                v_reason := format('View %s not found in public schema', v_view_name);
            ELSE
                SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = v_view_name
                      AND column_name = 'organization_id'
                ) INTO v_view_has_org;

                SELECT EXISTS (
                    SELECT 1 FROM information_schema.columns
                    WHERE table_schema = 'public'
                      AND table_name = v_view_name
                      AND column_name = 'decision_time'
                ) INTO v_view_has_time;

                IF NOT v_view_has_org OR NOT v_view_has_time THEN
                    v_outcome := 'invalid_sql_view';
                    v_reason := 'sql_view must expose organization_id and decision_time columns';
                ELSE
                    v_view_sql := format(
                        'SELECT COUNT(*)::int FROM public.%I WHERE organization_id = $1::uuid AND decision_time > now() - $2::interval',
                        v_view_name
                    );
                    EXECUTE v_view_sql INTO v_match_count USING v_rule.organization_id, v_window_interval;

                    IF v_view_comparison = '>' THEN
                        v_threshold_met := v_match_count > v_view_threshold;
                    ELSIF v_view_comparison = '>=' THEN
                        v_threshold_met := v_match_count >= v_view_threshold;
                    ELSIF v_view_comparison = '<' THEN
                        v_threshold_met := v_match_count < v_view_threshold;
                    ELSIF v_view_comparison = '<=' THEN
                        v_threshold_met := v_match_count <= v_view_threshold;
                    ELSIF v_view_comparison = '=' THEN
                        v_threshold_met := v_match_count = v_view_threshold;
                    ELSE
                        v_threshold_met := v_match_count > v_view_threshold;
                    END IF;

                    IF v_threshold_met THEN
                        v_outcome := 'alert_triggered';
                        v_reason := format(
                            'Alert triggered (sql_view %s: matches=%s in last %s minutes)',
                            v_view_name,
                            v_match_count,
                            v_window_minutes
                        );

                        v_severity := COALESCE(
                            (SELECT lv.value FROM lookup_values lv WHERE lv.id = v_rule.alert_severity_lookup_id LIMIT 1),
                            'warning'
                        );
                        v_message := COALESCE(v_rule.rule_name, 'alert') || ': ' || v_reason;

                        IF NOT EXISTS (
                            SELECT 1
                            FROM alert_triggers atr
                            WHERE atr.alert_rule_id = v_rule.id
                              AND atr.resource_type = 'alert_rule'
                              AND atr.resource_id = v_rule.id
                              AND atr.timestamp > now() - v_window_interval
                            LIMIT 1
                        ) THEN
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
                                    'match_count', v_match_count,
                                    'window_minutes', v_window_minutes,
                                    'trigger_source', v_rule.trigger_source,
                                    'view', v_view_name,
                                    'threshold', v_view_threshold,
                                    'comparison', v_view_comparison,
                                    'correlation_id', v_context,
                                    'alert_channels', v_rule.alert_channels
                                ))
                            );
                        END IF;
                    ELSE
                        v_outcome := 'no_alert';
                        v_reason := format(
                            'Threshold not met (sql_view %s: matches=%s, threshold=%s, comparison=%s, window_minutes=%s)',
                            v_view_name,
                            v_match_count,
                            v_view_threshold,
                            v_view_comparison,
                            v_window_minutes
                        );
                    END IF;
                END IF;
            END IF;

        ELSE
            v_outcome := 'unsupported_trigger_source';
            v_reason := format('Trigger source %s not yet supported by alert worker', v_rule.trigger_source);
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
            p_decision_inputs := jsonb_build_object(
                'trigger_category', v_trigger_category,
                'trigger_outcome', v_trigger_outcome,
                'match_count', v_match_count,
                'trigger_source', v_rule.trigger_source,
                'window_minutes', v_window_minutes
            ),
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

ALTER FUNCTION public.run_alert_aggregation_worker()
  SET search_path TO public, extensions, pg_temp;

COMMIT;

