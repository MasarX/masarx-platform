-- Migration: Phase 0 - Worker Naming Baseline
-- Purpose: Ensure canonical worker identifiers from seed data are present in worker_registry and cron_config.
-- Strategy: Seed (or re-seed) worker_registry/cron_config entries using the canonical names defined in 202510110010_seed_data.sql.
-- Notes:
--   * No worker functions are created or modified in this migration. Subsequent phases will introduce/replace the SQL worker bodies.
--   * This migration is idempotent and can be re-run safely (all writes use ON CONFLICT).

-- =============================================================================
-- Canonical Worker Definitions (from seed data)
-- =============================================================================
-- 1. outbound_worker
-- 2. webhook_processor_worker
-- 3. campaign_enrollment_worker
-- 4. campaign_dispatcher_worker
-- 5. alert_aggregation_worker
-- 6. circuit_breaker_recovery_worker
-- 7. cache_cleanup_worker
-- =============================================================================

-- Upsert canonical worker entries into worker_registry (keeps descriptions/configs aligned with seed data).
INSERT INTO worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES
    (
        'outbound_worker',
        'message_delivery',
        'Unified HTTP client for ALL external API calls (geocoding, comms, webhooks, saas_proxy)',
        '*/1 * * * *',
        '{
            "batch_size": 100,
            "timeout_seconds": 30,
            "retry_policy": {"max_retries": 3, "backoff": "exponential"},
            "operation_types": ["geocoding", "comms", "webhooks", "saas_proxy"],
            "channels": ["sms", "email", "whatsapp", "push"]
        }'::jsonb,
        true
    ),
    (
        'webhook_processor_worker',
        'webhook_delivery',
        'Processes ALL inbound webhooks (carrier updates, customer actions, etc.)',
        '*/2 * * * *',
        '{
            "batch_size": 50,
            "timeout_seconds": 60,
            "retry_policy": {"max_retries": 5, "backoff": "exponential"},
            "operation_types": ["webhook_ingestion"],
            "concurrent_workers": 3
        }'::jsonb,
        true
    ),
    (
        'campaign_enrollment_worker',
        'workflow',
        'Daily enrollment for proactive outreach campaigns (status-based triggers)',
        '0 2 * * *',
        '{
            "batch_size": 500,
            "timeout_seconds": 300,
            "operation_types": ["campaigns"],
            "parallel_execution": true,
            "max_concurrent": 10
        }'::jsonb,
        true
    ),
    (
        'campaign_dispatcher_worker',
        'workflow',
        'Hourly dispatcher for multi-day campaigns (sends scheduled messages)',
        '0 * * * *',
        '{
            "batch_size": 200,
            "timeout_seconds": 180,
            "operation_types": ["campaigns"],
            "respect_quiet_hours": true
        }'::jsonb,
        true
    ),
    (
        'alert_aggregation_worker',
        'monitoring',
        'Evaluates alert_rules every 5 minutes (decision_log driven alert triggers)',
        '*/5 * * * *',
        '{
            "batch_size": 100,
            "timeout_seconds": 60,
            "operation_types": ["monitoring"],
            "check_threshold_percent": 80,
            "alert_channels": ["email", "slack"]
        }'::jsonb,
        true
    ),
    (
        'circuit_breaker_recovery_worker',
        'monitoring',
        'Tests half-open circuits every 10 minutes (provider health checks)',
        '*/10 * * * *',
        '{
            "timeout_seconds": 30,
            "operation_types": ["resilience"],
            "test_endpoints": true,
            "update_registry": true
        }'::jsonb,
        true
    ),
    (
        'cache_cleanup_worker',
        'maintenance',
        'Daily maintenance (archives partitions, cleans cache, vacuum)',
        '0 3 * * 0',
        '{
            "operation_types": ["maintenance"],
            "create_partitions_ahead": {"weekly": 4, "monthly": 3},
            "archive_older_than_months": 6,
            "vacuum_tables": true,
            "tables": ["webhook_log", "api_call_log", "decision_log", "outbound_history", "workflow_execution_log", "webhook_events"]
        }'::jsonb,
        true
    )
ON CONFLICT (worker_name) DO UPDATE
SET
    worker_type = EXCLUDED.worker_type,
    description = EXCLUDED.description,
    schedule = EXCLUDED.schedule,
    config = EXCLUDED.config,
    is_active = EXCLUDED.is_active,
    updated_at = now();

-- Create cron_config entries for all canonical workers (respecting worker_registry FK).
INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES
    ('outbound_worker', 60, 100, true, 'Throttle controls for outbound HTTP worker'),
    ('webhook_processor_worker', 120, 50, true, 'Webhook ingestion worker throttle config'),
    ('campaign_enrollment_worker', 86400, 500, true, 'Daily campaign enrollment (2 AM)'),
    ('campaign_dispatcher_worker', 3600, 200, true, 'Hourly campaign dispatcher'),
    ('alert_aggregation_worker', 300, 100, true, 'Alert aggregation every 5 minutes'),
    ('circuit_breaker_recovery_worker', 600, 50, true, 'Circuit breaker recovery (10 minute cadence)'),
    ('cache_cleanup_worker', 604800, 1000, true, 'Weekly cache maintenance (Sunday 3 AM)')
ON CONFLICT (worker_name) DO UPDATE
SET
    interval_seconds = EXCLUDED.interval_seconds,
    batch_size = EXCLUDED.batch_size,
    enabled = EXCLUDED.enabled,
    notes = EXCLUDED.notes,
    last_run_at = NULL;  -- reset last_run_at so the next execution recalculates throttle window

-- Migration complete (no further actions).
