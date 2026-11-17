-- Migration: Geocoding alert rules baseline
-- Purpose: Seed alert rules for fallback spikes and SLA breaches tied to geocoding metrics.

BEGIN;

WITH severity_lookup AS (
    SELECT
        ld.category,
        lv.value,
        lv.id
    FROM lookup_values lv
    JOIN lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'severity_level'
      AND lv.value IN ('warning', 'error')
),
orgs AS (
    SELECT id, slug
    FROM organizations
    WHERE slug IS NOT NULL
),
fallback_rules AS (
    SELECT
        o.id AS organization_id,
        format('ops::%s::geocoding_fallback_spike', replace(o.slug, ' ', '_')) AS rule_name,
        (SELECT id FROM severity_lookup WHERE value = 'warning') AS severity_id,
        jsonb_build_object(
            'metric', 'fallback_rate',
            'window_minutes', 10,
            'threshold', 5
        ) AS trigger_conditions,
        jsonb_build_array('organization_id', 'provider_name') AS throttle_fields
    FROM orgs o
),
manual_review_rules AS (
    SELECT
        o.id AS organization_id,
        format('ops::%s::geocoding_manual_review_sla', replace(o.slug, ' ', '_')) AS rule_name,
        (SELECT id FROM severity_lookup WHERE value = 'error') AS severity_id,
        jsonb_build_object(
            'metric', 'manual_review_overdue',
            'threshold_minutes', 60,
            'status', 'pending'
        ) AS trigger_conditions,
        jsonb_build_array('organization_id', 'queue_assignment') AS throttle_fields
    FROM orgs o
),
insert_data AS (
    SELECT
        organization_id,
        rule_name,
        TRUE AS enabled,
        800 AS priority,
        'geocoding_attempts' AS trigger_source,
        trigger_conditions,
        10 AS throttle_window_minutes,
        throttle_fields AS throttle_key_fields,
        severity_id,
        jsonb_build_array('slack', 'email') AS alert_channels,
        NULL::UUID AS message_template_id,
        jsonb_build_object('playbook', 'GEO-002') AS message_variables
    FROM fallback_rules
    UNION ALL
    SELECT
        organization_id,
        rule_name,
        TRUE,
        900,
        'manual_review_tasks',
        trigger_conditions,
        15,
        throttle_fields,
        severity_id,
        jsonb_build_array('slack', 'email', 'sms'),
        NULL::UUID,
        jsonb_build_object('playbook', 'GEO-004')
    FROM manual_review_rules
)
INSERT INTO alert_rules (
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
    created_by
)
SELECT
    i.organization_id,
    i.rule_name,
    i.enabled,
    i.priority,
    i.trigger_source,
    i.trigger_conditions,
    i.throttle_window_minutes,
    i.throttle_key_fields,
    i.severity_id,
    i.alert_channels,
    i.message_template_id,
    i.message_variables,
    NULL
FROM insert_data i
WHERE i.severity_id IS NOT NULL
ON CONFLICT (rule_name) DO UPDATE
SET
    trigger_conditions = EXCLUDED.trigger_conditions,
    alert_channels = EXCLUDED.alert_channels,
    throttle_window_minutes = EXCLUDED.throttle_window_minutes,
    throttle_key_fields = EXCLUDED.throttle_key_fields,
    priority = EXCLUDED.priority,
    updated_at = now();

COMMIT;
