BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Ensure the worker is runnable (bypass throttle for this transaction).
UPDATE cron_config
SET enabled = TRUE,
    last_run_at = now() - make_interval(secs => 3600)
WHERE worker_name = 'alert_aggregation_worker';

-- Create a deterministic view the worker can count against (must expose organization_id + decision_time).
CREATE OR REPLACE VIEW public.pgtap_alert_view_v AS
SELECT
  (SELECT id FROM organizations ORDER BY created_at LIMIT 1) AS organization_id,
  now() AS decision_time;

CREATE TEMP TABLE pgtap_alert_sql_view_ctx (
  rule_id UUID
);

-- Create a sql_view-driven alert rule and assert the aggregation worker creates a trigger.
WITH org AS (
  SELECT id FROM organizations ORDER BY created_at LIMIT 1
), rule AS (
  INSERT INTO alert_rules (
    organization_id,
    rule_name,
    enabled,
    priority,
    trigger_source,
    trigger_conditions,
    throttle_window_minutes,
    alert_channels,
    created_at,
    updated_at
  )
  SELECT
    org.id,
    'pgtap_alert_sql_view_' || replace(gen_random_uuid()::text, '-', ''),
    TRUE,
    9999,
    'sql_view',
    jsonb_build_object(
      'view', 'pgtap_alert_view_v',
      'window_minutes', 5,
      'threshold', 0,
      'comparison', '>'
    ),
    5,
    jsonb_build_array('comms_whatsapp'),
    now(),
    now()
  FROM org
  RETURNING id
)
INSERT INTO pgtap_alert_sql_view_ctx (rule_id)
SELECT id FROM rule;

SELECT ok(TRUE, 'sql_view alert_rule inserted');

SELECT public.run_alert_aggregation_worker();

SELECT ok(
  EXISTS (
    SELECT 1
    FROM alert_triggers t
    WHERE t.alert_rule_id = (SELECT rule_id FROM pgtap_alert_sql_view_ctx LIMIT 1)
  ),
  'run_alert_aggregation_worker creates alert_triggers for sql_view rules'      
);

SELECT finish();

ROLLBACK;
