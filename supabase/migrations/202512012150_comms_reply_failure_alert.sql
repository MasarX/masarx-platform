-- Migration: Comms reply failure alert rule (view-backed, using severity_level lookups)
-- Date: 2025-12-01

BEGIN;

DO $$
DECLARE
  v_org uuid;
  v_warning uuid;
BEGIN
  SELECT id INTO v_org FROM organizations ORDER BY created_at LIMIT 1;
  IF v_org IS NULL THEN
    RAISE NOTICE 'No organizations found; skipping alert rule seed.';
    RETURN;
  END IF;

  SELECT lv.id INTO v_warning
  FROM lookup_definitions ld
  JOIN lookup_values lv ON lv.lookup_definition_id = ld.id
  WHERE ld.category = 'severity_level' AND lv.value = 'warning'
  LIMIT 1;

  INSERT INTO alert_rules (
      id,
      organization_id,
      rule_name,
      enabled,
      priority,
      trigger_source,
      trigger_conditions,
      throttle_window_minutes,
      throttle_key_fields,
      alert_severity_lookup_id,
      alert_channels,
      message_template_id,
      message_variables,
      created_at,
      updated_at
  )
  VALUES (
      gen_random_uuid(),
      v_org,
      'comms_reply_failures',
      TRUE,
      50,
      'sql_view',
      jsonb_build_object(
        'view', 'comms_reply_failures_v',
        'where', 'decision_time >= now() - interval ''5 minutes''',
        'threshold', 0,
        'comparison', '>'
      ),
      5,
      jsonb_build_array('organization_id'),
      v_warning,
      jsonb_build_array('ops'),
      NULL,
      jsonb_build_object(
        'note', 'Auto-alert when auto-replies fail (sent=false/non-2xx/error)'
      ),
      now(),
      now()
  )
  ON CONFLICT (rule_name) DO UPDATE
    SET organization_id = EXCLUDED.organization_id,
        enabled = TRUE,
        trigger_source = EXCLUDED.trigger_source,
        trigger_conditions = EXCLUDED.trigger_conditions,
        throttle_window_minutes = EXCLUDED.throttle_window_minutes,
        alert_severity_lookup_id = EXCLUDED.alert_severity_lookup_id,
        alert_channels = EXCLUDED.alert_channels,
        message_variables = EXCLUDED.message_variables,
        updated_at = now();
END$$;

COMMIT;
