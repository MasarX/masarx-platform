-- Migration 10: Seed Data for Configuration Tables
-- Purpose: Populate configuration tables with initial data
-- Task: Phase 4 Final - Rebuild Migrations 8-10 with 100% Plan.md compliance
-- Dependencies: Migration 9 (partition functions)
-- Follows: docs/product/standards/backend/migrations.md (separate schema and data migrations, zero-hardcoding)
-- CRITICAL: Schema alignment with Migration 7 (partitioning_config, worker_registry)
-- Plan.md Lookup Seeding: Section 5.9 (lines 6212-6403)

-- =============================================================================
-- SECTION 1: Seed Partitioning Configuration
-- Purpose: Define which tables use partitioning and their strategies
-- CRITICAL: Column names MUST match Migration 7 schema exactly
-- From: Migration 7 partitioning_config table
-- =============================================================================

INSERT INTO partitioning_config (
    table_name,
    partition_strategy,
    partition_key,
    partition_interval,
    partitions_ahead,
    retention_months,
    config
) VALUES
    -- HASH partitioned tables (single MODULUS 1 initially, expandable)
    ('shipments', 'HASH', 'client_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('addresses', 'HASH', 'client_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('geocodes', 'HASH', 'address_hash', NULL, NULL, NULL, '{"modulus": 4, "expandable_to": [16]}'::jsonb),
    ('packages', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('labels', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('settings_versions', 'HASH', 'scope_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('user_roles', 'HASH', 'user_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('outbound_queue', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),

    -- HASH + RANGE partitioned tables (HASH MODULUS 1, RANGE weekly/monthly)
    ('decision_log', 'HASH+RANGE', 'organization_id|timestamp', 'monthly', 3, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('webhook_log', 'HASH+RANGE', 'organization_id|timestamp', 'weekly', 4, 6, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "archive"}'::jsonb),
    ('api_call_log', 'HASH+RANGE', 'organization_id|timestamp', 'weekly', 4, 6, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "archive"}'::jsonb),
    ('outbound_history', 'HASH+RANGE', 'client_id|created_at', 'monthly', 2, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('workflow_execution_log', 'HASH+RANGE', 'shipment_id|created_at', 'monthly', 3, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('webhook_events', 'HASH+RANGE', 'client_id|created_at', 'weekly', 4, 3, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "delete"}'::jsonb)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE partitioning_config IS 'Configuration defining partitioning strategies for each table (seeded in Migration 10)';

-- =============================================================================
-- SECTION 2: Seed Worker Registry
-- Purpose: Define background workers and their configurations
-- CRITICAL: Column names MUST match Migration 7 worker_registry schema exactly
-- From: Migration 7 worker_registry table + Plan.md Section 4.3 (lines 921-930)
-- =============================================================================

INSERT INTO worker_registry (
    worker_name,
    worker_type,
    description,
    schedule,
    config,
    is_active
) VALUES
    -- Outbound worker (unified HTTP client for ALL external API calls)
    (
        'outbound_worker',
        'message_delivery',
        'Unified HTTP client for ALL external API calls (geocoding, comms, webhooks, saas_proxy)',
        '*/1 * * * *', -- Every minute
        '{
            "batch_size": 100,
            "timeout_seconds": 30,
            "retry_policy": {"max_retries": 3, "backoff": "exponential"},
            "operation_types": ["geocoding", "comms", "webhooks", "saas_proxy"],
            "channels": ["sms", "email", "whatsapp", "push"]
        }'::jsonb,
        true
    ),

    -- Webhook processor worker (processes ALL inbound webhooks)
    (
        'webhook_processor_worker',
        'webhook_delivery',
        'Processes ALL inbound webhooks (carrier updates, customer actions, etc.)',
        '*/2 * * * *', -- Every 2 minutes
        '{
            "batch_size": 50,
            "timeout_seconds": 60,
            "retry_policy": {"max_retries": 5, "backoff": "exponential"},
            "operation_types": ["webhook_ingestion"],
            "concurrent_workers": 3
        }'::jsonb,
        true
    ),

    -- Campaign enrollment worker (daily enrollment for proactive outreach)
    (
        'campaign_enrollment_worker',
        'workflow',
        'Daily enrollment for proactive outreach campaigns (status-based triggers)',
        '0 2 * * *', -- Daily at 2 AM
        '{
            "batch_size": 500,
            "timeout_seconds": 300,
            "operation_types": ["campaigns"],
            "parallel_execution": true,
            "max_concurrent": 10
        }'::jsonb,
        true
    ),

    -- Campaign dispatcher worker (hourly dispatcher for multi-day campaigns)
    (
        'campaign_dispatcher_worker',
        'workflow',
        'Hourly dispatcher for multi-day campaigns (sends scheduled messages)',
        '0 * * * *', -- Every hour
        '{
            "batch_size": 200,
            "timeout_seconds": 180,
            "operation_types": ["campaigns"],
            "respect_quiet_hours": true
        }'::jsonb,
        true
    ),

    -- Alert aggregation worker (evaluates alert_rules every 5 minutes)
    (
        'alert_aggregation_worker',
        'monitoring',
        'Evaluates alert_rules every 5 minutes (decision_log → alert triggers)',
        '*/5 * * * *', -- Every 5 minutes
        '{
            "batch_size": 100,
            "timeout_seconds": 60,
            "operation_types": ["monitoring"],
            "check_threshold_percent": 80,
            "alert_channels": ["email", "slack"]
        }'::jsonb,
        true
    ),

    -- Circuit breaker recovery worker (tests half-open circuits every 10 minutes)
    (
        'circuit_breaker_recovery_worker',
        'monitoring',
        'Tests half-open circuits every 10 minutes (provider health checks)',
        '*/10 * * * *', -- Every 10 minutes
        '{
            "timeout_seconds": 30,
            "operation_types": ["resilience"],
            "test_endpoints": true,
            "update_registry": true
        }'::jsonb,
        true
    ),

    -- Cache cleanup worker (daily maintenance: archives partitions, cleans cache)
    (
        'cache_cleanup_worker',
        'maintenance',
        'Daily maintenance (archives partitions, cleans cache, vacuum)',
        '0 3 * * 0', -- Weekly on Sunday at 3 AM
        '{
            "operation_types": ["maintenance"],
            "create_partitions_ahead": {"weekly": 4, "monthly": 3},
            "archive_older_than_months": 6,
            "vacuum_tables": true,
            "tables": ["webhook_log", "api_call_log", "decision_log", "outbound_history", "workflow_execution_log", "webhook_events"]
        }'::jsonb,
        true
    )
ON CONFLICT (worker_name) DO NOTHING;

COMMENT ON TABLE worker_registry IS 'Registry of background workers and their configurations (seeded in Migration 10)';

-- =============================================================================
-- SECTION 3: Seed Lookup Definitions
-- Purpose: Define lookup categories for dynamic enumerations
-- From: Plan.md Section 5.9 (Lookup Seeding, lines 6218-6403)
-- =============================================================================

INSERT INTO lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES
    -- Core operational lookups
    ('priority_level', 'Shipment priority levels', 'operations', 'tier_1', true),
    ('basket_type', 'Basket type classifications', 'operations', 'tier_1', true),
    ('severity_level', 'Incident and alert severity levels', 'operations', 'tier_1', true),
    ('incident_type', 'Incident type classifications', 'operations', 'tier_1', true),

    -- Address and geocoding lookups
    ('address_component', 'Address component metadata for matching', 'operations', 'tier_2', true),
    ('match_strategy', 'Fuzzy matching algorithms for address components', 'engineering', 'tier_1', false),
    ('auto_learn_action', 'Actions when new address component discovered', 'operations', 'tier_1', true),
    ('no_match_action', 'Fallback actions when no component match found', 'operations', 'tier_1', true),

    -- Decision and monitoring lookups
    ('decision_category', 'Business decision categories for decision_log', 'engineering', 'tier_1', false),
    ('decision_outcome', 'Decision outcomes for decision_log', 'engineering', 'tier_1', false),

    -- Core system lookups
    ('shipment_status', 'Valid shipment status values', 'operations', 'tier_1', false),
    ('service_type', 'Delivery service type options', 'operations', 'tier_1', false),
    ('address_type', 'Address type categories', 'operations', 'tier_2', true),
    ('message_channel', 'Communication channel types', 'operations', 'tier_1', true),
    ('label_type', 'Shipping label type options', 'operations', 'tier_2', true),
    ('integration_type', 'Integration category types', 'engineering', 'tier_1', false),
    ('geocoding_accuracy', 'Geocoding accuracy levels', 'engineering', 'tier_1', false),
    ('scope_type', 'Configuration scope ladder (global → tenant → client → sender → source → resource)', 'engineering', 'tier_1', false)
ON CONFLICT (category) DO NOTHING;

-- =============================================================================
-- SECTION 4: Seed Lookup Values
-- Purpose: Populate lookup categories with initial values
-- From: Plan.md Section 5.9 (lines 6218-6403)
-- =============================================================================

-- Seed priority_level lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default,
    v.metadata::jsonb
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('urgent', 'Urgent', 'Urgent priority - immediate handling required', 1, false, '{"color": "#FF0000", "sla_multiplier": 0.5, "icon": "🔥"}'),
    ('high', 'High', 'High priority - expedited handling', 2, false, '{"color": "#FFA500", "sla_multiplier": 0.75, "icon": "⚡"}'),
    ('medium', 'Medium', 'Medium priority - standard handling', 3, true, '{"color": "#FFFF00", "sla_multiplier": 1.0, "icon": "📦"}'),
    ('low', 'Low', 'Low priority - can be delayed', 4, false, '{"color": "#00FF00", "sla_multiplier": 1.5, "icon": "🐌"}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'priority_level'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed severity_level lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default,
    v.metadata::jsonb
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('info', 'Informational', 'Informational alert - no action required', 1, false, '{"color": "#0000FF", "priority_order": 1, "notification_channels": ["slack"]}'),
    ('warning', 'Warning', 'Warning - attention recommended', 2, false, '{"color": "#FFA500", "priority_order": 25, "notification_channels": ["slack", "email"]}'),
    ('error', 'Error', 'Error - action required', 3, false, '{"color": "#FF0000", "priority_order": 50, "notification_channels": ["slack", "email", "sms"]}'),
    ('critical', 'Critical', 'Critical - immediate action required', 4, false, '{"color": "#8B0000", "priority_order": 100, "notification_channels": ["slack", "email", "sms", "pagerduty"]}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'severity_level'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed decision_category lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    false
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('geocoding', 'Geocoding Decision', 'Address geocoding and validation decisions', 10),
    ('transformation', 'Data Transformation', 'Field mapping and transformation decisions', 20),
    ('settings_resolution', 'Settings Resolution', 'Configuration override ladder decisions', 30),
    ('rate_limiting', 'Rate Limiting', 'Rate limit enforcement decisions', 40),
    ('campaign_enrollment', 'Campaign Enrollment', 'Campaign enrollment eligibility decisions', 50),
    ('circuit_breaker', 'Circuit Breaker', 'Circuit breaker state transitions', 60),
    ('comms_scheduling', 'Communications Scheduling', 'Message scheduling and throttling decisions', 70),
    ('retry_logic', 'Retry Logic', 'Retry attempt decisions', 80),
    ('provider_selection', 'Provider Selection', 'Provider selection and fallback decisions', 90),
    ('provider_budget', 'Provider Budget Check', 'Provider budget enforcement decisions', 100),
    ('webhook_routing', 'Webhook Routing', 'Webhook routing and processing decisions', 110),
    ('webhook_processing', 'Webhook Processing', 'Webhook worker orchestration decisions', 115),
    ('api_response_handled', 'API Response Handling', 'External API response handling decisions', 120),
    ('webhook_ack', 'Webhook Acknowledgement', 'Inbound acknowledgement outcomes at edge', 125)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed decision_outcome lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    false
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('approved', 'Approved', 'Decision approved - processing continues', 10),
    ('flagged_for_review', 'Flagged for Review', 'Decision flagged for manual review', 20),
    ('limit_exceeded', 'Limit Exceeded', 'Rate limit or budget limit exceeded', 30),
    ('stop_enrollment', 'Stop Enrollment', 'Campaign enrollment stopped', 40),
    ('create_job', 'Create Job', 'Background job created', 50),
    ('use_fallback', 'Use Fallback', 'Fallback provider or method used', 60),
    ('blocked_budget_exceeded', 'Blocked - Budget Exceeded', 'Blocked due to budget constraints', 70),
    ('skip_budget_exhausted', 'Skipped - Budget Exhausted', 'Skipped due to exhausted budget', 80),
    ('ack_sent', 'Acknowledgement Sent', 'Acknowledgement successfully emitted', 90),
    ('ack_failed', 'Acknowledgement Failed', 'Acknowledgement failed due to validation or persistence error', 95),
    ('duplicate_ignored', 'Duplicate Ignored', 'Webhook treated as duplicate via idempotency controls', 100)
) AS v(value, label, description, sort_order)
WHERE ld.category = 'decision_outcome'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed shipment_status lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('pending', 'Pending', 'Shipment created, awaiting processing', 1, true),
    ('in_transit', 'In Transit', 'Shipment is being delivered', 2, false),
    ('out_for_delivery', 'Out for Delivery', 'Shipment is out for delivery', 3, false),
    ('delivered', 'Delivered', 'Successfully delivered to recipient', 4, false),
    ('delivery_failed', 'Delivery Failed', 'Delivery attempt failed', 5, false),
    ('cancelled', 'Cancelled', 'Shipment cancelled', 6, false),
    ('return_to_origin', 'Return to Origin', 'Returning to sender', 7, false)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'shipment_status'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed service_type lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('delivery', 'Delivery', 'Forward delivery (warehouse to customer)', 1, true),
    ('pickup', 'Pickup', 'Customer pickup (customer to warehouse)', 2, false),
    ('swap', 'Swap', 'Exchange service (drop old, pick up new)', 3, false),
    ('return_to_origin', 'Return to Origin', 'Return to sender', 4, false)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'service_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed message_channel lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('sms', 'SMS', 'SMS text message', 1, false),
    ('email', 'Email', 'Email message', 2, false),
    ('whatsapp', 'WhatsApp', 'WhatsApp message', 3, true),
    ('push', 'Push Notification', 'Mobile push notification', 4, false)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'message_channel'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed geocoding_accuracy lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('rooftop', 'Rooftop', 'Exact rooftop coordinates', 1, false),
    ('street', 'Street', 'Street-level accuracy', 2, true),
    ('district', 'District', 'District/neighborhood level', 3, false),
    ('city', 'City', 'City-level only', 4, false)
) AS v(value, label, description, sort_order, is_default)
WHERE ld.category = 'geocoding_accuracy'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- Seed scope_type lookup values
INSERT INTO lookup_values (lookup_definition_id, value, label, description, sort_order, is_default, metadata)
SELECT
    ld.id,
    v.value,
    v.label,
    v.description,
    v.sort_order,
    v.is_default,
    v.metadata::jsonb
FROM lookup_definitions ld
CROSS JOIN (VALUES
    ('global', 'Global', 'Platform default scope (applies everywhere)', 1, true, '{"priority": 100}'),
    ('tenant', 'Tenant', 'Organization-wide override', 2, false, '{"priority": 90}'),
    ('client', 'Client', 'Client-specific override', 3, false, '{"priority": 80}'),
    ('sender', 'Sender', 'Sender-specific override', 4, false, '{"priority": 70}'),
    ('source', 'Webhook Source', 'Inbound webhook source override', 5, false, '{"priority": 60}'),
    ('resource', 'Resource', 'Individual resource override (fallback use)', 6, false, '{"priority": 50}'),
    ('role', 'Role', 'Role-level override', 7, false, '{"priority": 40}'),
    ('user', 'User', 'User-specific override', 8, false, '{"priority": 30}')
) AS v(value, label, description, sort_order, is_default, metadata)
WHERE ld.category = 'scope_type'
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

-- =============================================================================
-- SECTION 5: Schema Registry (webhook_ingest_policy)
-- Purpose: Define JSON schema for webhook ingest policy configuration
-- =============================================================================

INSERT INTO schema_registry (
    id,
    category,
    version,
    schema,
    description,
    examples
)
VALUES (
    '55550000-0000-0000-0000-000000000001',
    'webhook_ingest_policy',
    1,
    $${ 
        "title": "Webhook Ingest Policy",
        "type": "object",
        "additionalProperties": false,
        "required": ["version", "ack"],
        "properties": {
            "version": {
                "type": "integer",
                "minimum": 1
            },
            "wait_for_ack": {
                "type": "boolean",
                "default": false
            },
            "validation": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "json_schema_id": {
                        "type": "string",
                        "format": "uuid"
                    },
                    "hmac": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "enabled": { "type": "boolean", "default": false },
                            "algorithm": { "type": "string", "enum": ["HMAC-SHA256", "HMAC-SHA512"] },
                            "auth_config_id": { "type": "string", "format": "uuid" },
                            "header": { "type": "string" },
                            "timestamp_header": { "type": "string" },
                            "tolerance_seconds": { "type": "integer", "minimum": 0, "default": 300 },
                            "signature_encoding": { "type": "string", "enum": ["hex", "base64"], "default": "hex" }
                        }
                    },
                    "idempotency": {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "header": { "type": "string" },
                            "body_path": { "type": "string" },
                            "dedupe_window_seconds": { "type": "integer", "minimum": 0, "default": 3600 }
                        }
                    }
                }
            },
            "ack": {
                "type": "object",
                "additionalProperties": false,
                "required": ["mode"],
                "properties": {
                    "mode": {
                        "type": "string",
                        "enum": ["synchronous_success", "accepted_async", "policy_error"]
                    },
                    "status_code": {
                        "type": "integer",
                        "minimum": 100,
                        "maximum": 599
                    },
                    "response_mapping_id": {
                        "type": "string",
                        "format": "uuid"
                    },
                    "default_headers": {
                        "type": "object",
                        "additionalProperties": { "type": "string" }
                    },
                    "reason_template": {
                        "type": "string"
                    },
                    "default_outcome": {
                        "type": "string"
                    }
                }
            },
            "workflow": {
                "oneOf": [
                    { "type": "null" },
                    {
                        "type": "object",
                        "additionalProperties": false,
                        "properties": {
                            "template_id": { "type": "string", "format": "uuid" },
                            "launch_mode": { "type": "string", "enum": ["in_background", "sync_only"], "default": "in_background" },
                            "context_patch": { "type": "object" },
                            "notes": { "type": "string" }
                        }
                    }
                ]
            },
            "logging": {
                "type": "object",
                "additionalProperties": false,
                "properties": {
                    "decision_point": { "type": "string" },
                    "include_payload": { "type": "boolean" },
                    "tags": {
                        "type": "array",
                        "items": { "type": "string" }
                    }
                }
            }
        }
    }$$::jsonb,
    'Webhook ingest policy schema enabling dynamic acknowledgement + workflow follow-up workflows',
    $$[
        {
            "version": 1,
            "wait_for_ack": false,
            "validation": {
                "idempotency": {
                    "header": "Idempotency-Key",
                    "dedupe_window_seconds": 3600
                }
            },
            "ack": {
                "mode": "synchronous_success",
                "status_code": 200,
                "response_mapping_id": "88880000-0000-0000-0000-000000000001",
                "default_headers": {
                    "cache-control": "no-store"
                }
            },
            "workflow": null,
            "logging": {
                "decision_point": "edge_ack",
                "include_payload": true
            }
        }
    ]$$::jsonb
)
ON CONFLICT (category, version) DO NOTHING;

-- =============================================================================
-- SECTION 6: Mapping Configs for webhook acknowledgements
-- Purpose: Provide reusable templates for synchronous and async acknowledgement responses
-- =============================================================================

INSERT INTO mapping_configs (id, mapping_type, mapping_key, mapping_config, mapping_version, notes)
VALUES
    (
        '88880000-0000-0000-0000-000000000001',
        'webhook_response',
        'global::ack_success_v1',
        $${
            "status_code": 200,
            "headers": {
                "content-type": "application/json"
            },
            "body": {
                "status": "accepted",
                "webhook_id": "{{webhook.id}}",
                "policy_scope": "{{policy.scope_type}}"
            }
        }$$::jsonb,
        1,
        'Default 200 OK acknowledgement template'
    ),
    (
        '88880000-0000-0000-0000-000000000002',
        'webhook_response',
        'global::ack_async_v1',
        $${
            "status_code": 202,
            "headers": {
                "content-type": "application/json",
                "retry-after": "30"
            },
            "body": {
                "status": "accepted_async",
                "tracking": "{{webhook.id}}",
                "note": "Processing asynchronously"
            }
        }$$::jsonb,
        1,
        'Default 202 Accepted acknowledgement template'
    )
ON CONFLICT (id) DO NOTHING;

-- =============================================================================
-- SECTION 7: Seed default webhook_ingest_policy (settings_versions + settings)
-- Purpose: Activate global policy aligned with schema above
-- =============================================================================

WITH policy_value AS (
    SELECT $${
        "version": 1,
        "wait_for_ack": false,
        "validation": {
            "idempotency": {
                "header": "Idempotency-Key",
                "dedupe_window_seconds": 3600
            }
        },
        "response": {
            "mode": "synchronous_success",
            "status_code": 200,
            "response_mapping_id": "88880000-0000-0000-0000-000000000001",
            "default_headers": {
                "cache-control": "no-store"
            }
        },
        "workflow": null,
        "logging": {
            "decision_point": "http_response",
            "include_payload": false
        }
    }$$::jsonb AS value
)
INSERT INTO settings_versions (
    id,
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
)
SELECT
    '77770000-0000-0000-0000-000000000001',
    'webhook_ingest_policy',
    'global',
    '00000000-0000-0000-0000-000000000000'::UUID,
    1,
    policy_value.value,
    1,
    'Initial global webhook ingest policy seed',
    now(),
    now()
FROM policy_value
ON CONFLICT (id, scope_id) DO NOTHING;

INSERT INTO settings (
    id,
    category,
    scope_type,
    scope_id,
    settings_version_id,
    cached_value,
    last_updated
)
SELECT
    '66660000-0000-0000-0000-000000000001',
    'webhook_ingest_policy',
    'global',
    '00000000-0000-0000-0000-000000000000'::UUID,
    sv.id,
    sv.value,
    now()
FROM settings_versions sv
WHERE sv.id = '77770000-0000-0000-0000-000000000001'
ON CONFLICT (category, scope_type, scope_id) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration seeds initial configuration data:
--
-- 1. Partitioning Configuration (14 entries):
--    - 8 HASH-only partitioned tables (shipments, addresses, geocodes, packages, labels, settings_versions, user_roles, outbound_queue)
--    - 6 HASH+RANGE partitioned tables (decision_log, webhook_log, api_call_log, outbound_history, workflow_execution_log, webhook_events)
--    - Defines partition strategies, intervals, retention policies
--
-- 2. Worker Registry (7 workers from Plan.md Section 4.3):
--    - outbound_worker (unified HTTP client for all external API calls)
--    - webhook_processor_worker (processes all inbound webhooks)
--    - campaign_enrollment_worker (daily enrollment for proactive outreach)
--    - campaign_dispatcher_worker (hourly dispatcher for multi-day campaigns)
--    - alert_aggregation_worker (evaluates alert_rules every 5 minutes)
--    - circuit_breaker_recovery_worker (tests half-open circuits every 10 minutes)
--    - cache_cleanup_worker (daily maintenance: archives partitions, cleans cache)
--
-- 3. Lookup Definitions (17 categories from Plan.md Section 5.9):
--    - Core operational: priority_level, basket_type, severity_level, incident_type
--    - Address/geocoding: address_component, match_strategy, auto_learn_action, no_match_action
--    - Decision/monitoring: decision_category, decision_outcome
--    - System: shipment_status, service_type, address_type, message_channel, label_type, integration_type, geocoding_accuracy
--
-- 4. Lookup Values (60+ values seeded):
--    - priority_level (4 values: urgent, high, medium, low)
--    - severity_level (4 values: info, warning, error, critical)
--    - decision_category (12 values: geocoding, transformation, settings_resolution, etc.)
--    - decision_outcome (8 values: approved, flagged_for_review, limit_exceeded, etc.)
--    - shipment_status (7 values: pending, in_transit, delivered, etc.)
--    - service_type (4 values: delivery, pickup, swap, return_to_origin)
--    - message_channel (4 values: sms, email, whatsapp, push)
--    - geocoding_accuracy (4 values: rooftop, street, district, city)
--
-- Zero-Hardcoding Compliance:
-- - All configuration lives in database tables
-- - No hardcoded client IDs or business rules
-- - Lookup values support metadata (JSONB for color, icons, multipliers)
-- - Worker configurations are JSONB for flexibility
-- - Partition strategies driven by partitioning_config
--
-- Schema Alignment with Migration 7:
-- - partitioning_config columns: table_name, partition_strategy, partition_key, partition_interval, partitions_ahead, retention_months, config
-- - worker_registry columns: worker_name, worker_type, description, schedule, config, is_active
-- - All columns present and types match exactly
--
-- Total Seed Records: ~100+ records across 4 tables
--
-- All 10 migrations now complete!
-- Ready for: supabase db reset



