-- Migration 10: Seed Data for Configuration Tables
-- Purpose: Populate configuration tables with initial data (partitioning_config, worker_registry, lookups)
-- Task: 5.4 - Create Migration 10: Seed Data
-- Dependencies: Migration 9 (partition functions)
-- Follows: docs/product/standards/backend/migrations.md (separate schema and data migrations, zero-hardcoding)

-- =============================================================================
-- SECTION 1: Seed Partitioning Configuration
-- Purpose: Define which tables use partitioning and their strategies
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
    -- HASH partitioned tables (21 partitions total)
    ('shipments', 'HASH', 'client_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('addresses', 'HASH', 'client_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('geocoding_cache', 'HASH', 'address_hash', NULL, NULL, NULL, '{"modulus": 4, "expandable_to": [16]}'::jsonb),
    ('packages', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('labels', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('settings_versions', 'HASH', 'client_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('user_roles', 'HASH', 'user_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),
    ('outbound_queue', 'HASH', 'shipment_id', NULL, NULL, NULL, '{"modulus": 1, "expandable_to": [4, 16]}'::jsonb),

    -- HASH + RANGE partitioned tables (12 RANGE partitions total)
    ('decision_log', 'HASH+RANGE', 'entity_id|created_at', 'monthly', 3, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('webhook_log', 'HASH+RANGE', 'client_id|created_at', 'weekly', 4, 6, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "archive"}'::jsonb),
    ('api_call_log', 'HASH+RANGE', 'request_id|created_at', 'weekly', 4, 6, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "archive"}'::jsonb),
    ('outbound_history', 'HASH+RANGE', 'message_id|created_at', 'monthly', 2, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('workflow_execution_log', 'HASH+RANGE', 'shipment_id|created_at', 'monthly', 3, 12, '{"hash_modulus": 1, "range_interval": "monthly", "retention_policy": "archive"}'::jsonb),
    ('webhook_events', 'HASH+RANGE', 'client_id|created_at', 'weekly', 4, 3, '{"hash_modulus": 1, "range_interval": "weekly", "retention_policy": "delete"}'::jsonb)
ON CONFLICT (table_name) DO NOTHING;

COMMENT ON TABLE partitioning_config IS 'Configuration defining partitioning strategies for each table (seeded in Migration 10)';

-- =============================================================================
-- SECTION 2: Seed Worker Registry
-- Purpose: Define background workers and their configurations
-- =============================================================================

INSERT INTO worker_registry (
    worker_name,
    worker_type,
    description,
    schedule,
    config,
    is_active
) VALUES
    -- Message delivery worker
    (
        'outbound_worker',
        'message_delivery',
        'Processes outbound message queue (SMS, email, WhatsApp, push)',
        '*/1 * * * *', -- Every minute
        '{
            "batch_size": 100,
            "timeout_seconds": 30,
            "retry_policy": {"max_retries": 3, "backoff": "exponential"},
            "channels": ["sms", "email", "whatsapp", "push"]
        }'::jsonb,
        true
    ),

    -- Webhook processor worker
    (
        'webhook_processor',
        'webhook_delivery',
        'Processes outbound webhook events',
        '*/2 * * * *', -- Every 2 minutes
        '{
            "batch_size": 50,
            "timeout_seconds": 60,
            "retry_policy": {"max_retries": 5, "backoff": "exponential"},
            "concurrent_workers": 3
        }'::jsonb,
        true
    ),

    -- Geocoding worker
    (
        'geocoding_worker',
        'geocoding',
        'Geocodes addresses in background using external API',
        '*/5 * * * *', -- Every 5 minutes
        '{
            "batch_size": 20,
            "timeout_seconds": 120,
            "providers": ["google_maps", "here_api"],
            "cache_ttl_days": 90
        }'::jsonb,
        true
    ),

    -- Partition management worker
    (
        'partition_manager',
        'maintenance',
        'Creates future partitions and archives old ones',
        '0 2 * * 0', -- Weekly on Sunday at 2 AM
        '{
            "create_partitions_ahead": {"weekly": 4, "monthly": 3},
            "archive_older_than_months": 6,
            "tables": ["webhook_log", "api_call_log", "decision_log", "outbound_history", "workflow_execution_log", "webhook_events"]
        }'::jsonb,
        true
    ),

    -- Workflow executor worker
    (
        'workflow_executor',
        'workflow',
        'Executes workflow templates for shipment lifecycle events',
        '*/1 * * * *', -- Every minute
        '{
            "batch_size": 50,
            "timeout_seconds": 300,
            "parallel_execution": true,
            "max_concurrent": 10
        }'::jsonb,
        true
    ),

    -- Provider health check worker
    (
        'provider_health_checker',
        'monitoring',
        'Monitors external provider health and updates circuit breakers',
        '*/10 * * * *', -- Every 10 minutes
        '{
            "timeout_seconds": 30,
            "test_endpoints": true,
            "update_registry": true
        }'::jsonb,
        true
    ),

    -- Budget monitor worker
    (
        'budget_monitor',
        'monitoring',
        'Monitors budget pools and triggers alerts when thresholds exceeded',
        '0 * * * *', -- Every hour
        '{
            "check_threshold_percent": 80,
            "alert_channels": ["email"],
            "auto_suspend_at_100_percent": true
        }'::jsonb,
        true
    )
ON CONFLICT (worker_name) DO NOTHING;

COMMENT ON TABLE worker_registry IS 'Registry of background workers and their configurations (seeded in Migration 10)';

-- =============================================================================
-- SECTION 3: Seed Core Lookups
-- Purpose: Populate lookup tables with core system values
-- =============================================================================

-- Insert lookup categories
INSERT INTO lookups (category, description, is_system) VALUES
    ('shipment_statuses', 'Valid shipment status values', true),
    ('service_types', 'Delivery service type options', true),
    ('priority_levels', 'Priority level options', true),
    ('address_types', 'Address type categories', true),
    ('geocoding_accuracy', 'Geocoding accuracy levels', true),
    ('message_channels', 'Communication channel types', true),
    ('label_types', 'Shipping label type options', true),
    ('integration_types', 'Integration category types', true)
ON CONFLICT (category) DO NOTHING;

-- Seed shipment statuses
INSERT INTO lookup_values (lookup_id, code, label_en, label_ar, description, sort_order, is_active)
SELECT
    l.id,
    v.code,
    v.label_en,
    v.label_ar,
    v.description,
    v.sort_order,
    v.is_active
FROM lookups l
CROSS JOIN (VALUES
    ('pending', 'Pending', 'قيد الانتظار', 'Shipment created, awaiting processing', 1, true),
    ('in_transit', 'In Transit', 'قيد التوصيل', 'Shipment is being delivered', 2, true),
    ('delivered', 'Delivered', 'تم التوصيل', 'Successfully delivered to recipient', 3, true),
    ('failed', 'Failed', 'فشل', 'Delivery attempt failed', 4, true),
    ('cancelled', 'Cancelled', 'ملغى', 'Shipment cancelled', 5, true),
    ('return_to_origin', 'Return to Origin', 'إرجاع للمصدر', 'Returning to sender', 6, true)
) AS v(code, label_en, label_ar, description, sort_order, is_active)
WHERE l.category = 'shipment_statuses'
ON CONFLICT (lookup_id, code) DO NOTHING;

-- Seed service types
INSERT INTO lookup_values (lookup_id, code, label_en, label_ar, description, sort_order, is_active)
SELECT
    l.id,
    v.code,
    v.label_en,
    v.label_ar,
    v.description,
    v.sort_order,
    v.is_active
FROM lookups l
CROSS JOIN (VALUES
    ('delivery', 'Delivery', 'توصيل', 'Forward delivery (warehouse to customer)', 1, true),
    ('pickup', 'Pickup', 'استلام', 'Customer pickup (customer to warehouse)', 2, true),
    ('swap', 'Swap', 'تبديل', 'Exchange service (drop old, pick up new)', 3, true),
    ('return_to_origin', 'Return to Origin', 'إرجاع للمصدر', 'Return to sender', 4, true)
) AS v(code, label_en, label_ar, description, sort_order, is_active)
WHERE l.category = 'service_types'
ON CONFLICT (lookup_id, code) DO NOTHING;

-- Seed priority levels
INSERT INTO lookup_values (lookup_id, code, label_en, label_ar, description, sort_order, is_active)
SELECT
    l.id,
    v.code,
    v.label_en,
    v.label_ar,
    v.description,
    v.sort_order,
    v.is_active
FROM lookups l
CROSS JOIN (VALUES
    ('low', 'Low', 'منخفض', 'Low priority', 1, true),
    ('medium', 'Medium', 'متوسط', 'Medium priority (default)', 2, true),
    ('high', 'High', 'عالي', 'High priority', 3, true),
    ('critical', 'Critical', 'حرج', 'Critical priority', 4, true)
) AS v(code, label_en, label_ar, description, sort_order, is_active)
WHERE l.category = 'priority_levels'
ON CONFLICT (lookup_id, code) DO NOTHING;

-- Seed message channels
INSERT INTO lookup_values (lookup_id, code, label_en, label_ar, description, sort_order, is_active)
SELECT
    l.id,
    v.code,
    v.label_en,
    v.label_ar,
    v.description,
    v.sort_order,
    v.is_active
FROM lookups l
CROSS JOIN (VALUES
    ('sms', 'SMS', 'رسالة نصية', 'SMS text message', 1, true),
    ('email', 'Email', 'بريد إلكتروني', 'Email message', 2, true),
    ('whatsapp', 'WhatsApp', 'واتساب', 'WhatsApp message', 3, true),
    ('push', 'Push Notification', 'إشعار فوري', 'Mobile push notification', 4, true)
) AS v(code, label_en, label_ar, description, sort_order, is_active)
WHERE l.category = 'message_channels'
ON CONFLICT (lookup_id, code) DO NOTHING;

-- Seed geocoding accuracy levels
INSERT INTO lookup_values (lookup_id, code, label_en, label_ar, description, sort_order, is_active)
SELECT
    l.id,
    v.code,
    v.label_en,
    v.label_ar,
    v.description,
    v.sort_order,
    v.is_active
FROM lookups l
CROSS JOIN (VALUES
    ('rooftop', 'Rooftop', 'دقيق', 'Exact rooftop coordinates', 1, true),
    ('street', 'Street', 'شارع', 'Street-level accuracy', 2, true),
    ('district', 'District', 'حي', 'District/neighborhood level', 3, true),
    ('city', 'City', 'مدينة', 'City-level only', 4, true)
) AS v(code, label_en, label_ar, description, sort_order, is_active)
WHERE l.category = 'geocoding_accuracy'
ON CONFLICT (lookup_id, code) DO NOTHING;

-- =============================================================================
-- SECTION 4: Seed System Permissions
-- Purpose: Define core permissions for RBAC system
-- =============================================================================

INSERT INTO permissions (resource, action, description) VALUES
    -- Shipment permissions
    ('shipments', 'read', 'View shipment details'),
    ('shipments', 'create', 'Create new shipments'),
    ('shipments', 'update', 'Update shipment details'),
    ('shipments', 'cancel', 'Cancel shipments'),
    ('shipments', 'delete', 'Delete shipments'),

    -- Client permissions
    ('clients', 'read', 'View client details'),
    ('clients', 'create', 'Create new clients'),
    ('clients', 'update', 'Update client configuration'),
    ('clients', 'suspend', 'Suspend client account'),

    -- Settings permissions
    ('settings', 'read', 'View configuration settings'),
    ('settings', 'update', 'Update configuration settings'),
    ('settings', 'approve', 'Approve configuration changes'),

    -- Webhook permissions
    ('webhooks', 'read', 'View webhook logs and configs'),
    ('webhooks', 'configure', 'Configure webhook endpoints'),

    -- Report permissions
    ('reports', 'read', 'View reports and analytics'),
    ('reports', 'export', 'Export report data')
ON CONFLICT (resource, action) DO NOTHING;

COMMENT ON TABLE permissions IS 'System permission registry (seeded in Migration 10)';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration seeds initial configuration data:
--
-- 1. Partitioning Configuration (14 entries):
--    - 8 HASH-only partitioned tables
--    - 6 HASH+RANGE partitioned tables
--    - Defines partition strategies, intervals, retention policies
--
-- 2. Worker Registry (7 workers):
--    - outbound_worker (message delivery)
--    - webhook_processor (webhook delivery)
--    - geocoding_worker (background geocoding)
--    - partition_manager (partition maintenance)
--    - workflow_executor (workflow automation)
--    - provider_health_checker (provider monitoring)
--    - budget_monitor (budget tracking)
--
-- 3. Core Lookups (8 categories):
--    - shipment_statuses (6 values)
--    - service_types (4 values)
--    - priority_levels (4 values)
--    - message_channels (4 values)
--    - geocoding_accuracy (4 values)
--    - address_types (placeholder)
--    - label_types (placeholder)
--    - integration_types (placeholder)
--
-- 4. System Permissions (16 permissions):
--    - shipments (5 actions)
--    - clients (4 actions)
--    - settings (3 actions)
--    - webhooks (2 actions)
--    - reports (2 actions)
--
-- Zero-Hardcoding Compliance:
-- - All configuration lives in database tables
-- - No hardcoded client IDs or business rules
-- - Lookup values support Arabic locale (label_ar)
-- - Worker configurations are JSONB for flexibility
-- - Partition strategies driven by partitioning_config
--
-- Total Seed Records: ~75 records across 4 tables
--
-- All 10 migrations now complete!
-- Ready for: supabase db reset

