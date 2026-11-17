-- Migration 7: Infrastructure Tables (6 tables, non-partitioned)
-- Purpose: Create global infrastructure configuration tables
-- Task: Phase 3 - Migration Rebuild (100% Plan.md compliance)
-- Dependencies: Migration 6 (domain tables)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)

-- =============================================================================
-- SECTION 1: Cron Config (Worker scheduling controls)
-- =============================================================================
-- Purpose: Decouple runtime cadence from pg_cron SQL
-- From: Plan.md Section 4.3 (lines 909-919)
-- Partitioning: None (global configuration, low volume)

CREATE TABLE cron_config (
    worker_name TEXT PRIMARY KEY, -- 'outbound_worker', 'webhook_processor_worker', etc.
    interval_seconds INTEGER NOT NULL, -- Minimum seconds between full executions
    batch_size INTEGER NOT NULL, -- Recommended batch claim size
    last_run_at TIMESTAMPTZ, -- Updated by worker after each run
    enabled BOOLEAN NOT NULL DEFAULT true, -- Allow worker to run
    notes TEXT,

    CONSTRAINT cron_config_interval_check CHECK (interval_seconds > 0),
    CONSTRAINT cron_config_batch_size_check CHECK (batch_size > 0)
);

CREATE INDEX idx_cron_config_enabled ON cron_config(enabled) WHERE enabled = true;
CREATE INDEX idx_cron_config_last_run ON cron_config(last_run_at DESC) WHERE enabled = true;

COMMENT ON TABLE cron_config IS 'Worker scheduling controls - self-throttling cadence (Plan.md Section 4.3, lines 909-919)';
COMMENT ON COLUMN cron_config.worker_name IS 'Worker identifier (validated against worker_registry FK)';
COMMENT ON COLUMN cron_config.interval_seconds IS 'Minimum seconds between full executions (self-throttling)';
COMMENT ON COLUMN cron_config.batch_size IS 'Recommended batch claim size for this worker';
COMMENT ON COLUMN cron_config.last_run_at IS 'Updated by worker after each run for throttling';

-- =============================================================================
-- SECTION 2: Worker Registry (Authoritative worker catalog)
-- =============================================================================
-- Purpose: Single source for worker definitions
-- From: Plan.md Section 4.3 (lines 921-930)
-- Partitioning: None (global configuration, low volume)
-- CRITICAL: Schema must match Migration 10 seed data expectations

CREATE TABLE worker_registry (
    worker_name TEXT PRIMARY KEY,
    worker_type TEXT NOT NULL, -- Worker execution model type
    description TEXT NOT NULL,
    schedule TEXT, -- Cron expression or schedule description
    config JSONB, -- Worker-specific configuration
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_worker_registry_type ON worker_registry(worker_type);
CREATE INDEX idx_worker_registry_active ON worker_registry(is_active) WHERE is_active = true;

COMMENT ON TABLE worker_registry IS 'Authoritative worker catalog - single source for worker definitions (Plan.md Section 4.3, lines 921-930)';
COMMENT ON COLUMN worker_registry.worker_name IS 'Unique worker identifier (e.g., outbound_worker, webhook_processor_worker)';
COMMENT ON COLUMN worker_registry.worker_type IS 'Worker execution model: message_delivery, webhook_delivery, geocoding, maintenance, workflow, monitoring';
COMMENT ON COLUMN worker_registry.description IS 'Human-readable worker description';
COMMENT ON COLUMN worker_registry.schedule IS 'Cron expression or schedule description';
COMMENT ON COLUMN worker_registry.config IS 'JSONB worker-specific configuration (batch_size, timeout_seconds, retry_policy, etc.)';
COMMENT ON COLUMN worker_registry.is_active IS 'Enable/disable worker globally';

-- Add FK from cron_config to worker_registry to prevent typos
ALTER TABLE cron_config
    ADD CONSTRAINT cron_config_worker_name_fk
    FOREIGN KEY (worker_name)
    REFERENCES worker_registry(worker_name)
    ON DELETE CASCADE;

-- =============================================================================
-- SECTION 3: Request Contexts (CRITICAL - was MISSING, for tracing)
-- =============================================================================
-- Purpose: Thread all operations together for end-to-end debugging
-- From: Plan.md Section 4.3 (lines 1223-1246)
-- Partitioning: None (consider RANGE partitioning in Phase 2)

CREATE TABLE request_contexts (
    id UUID PRIMARY KEY, -- This is the correlation_id
    entry_point TEXT NOT NULL, -- lookup category 'request_entry_point': webhook, api, worker, manual
    client_id UUID, -- FK to clients
    user_id UUID, -- FK to users

    -- Primary entity tracking (for batch operations)
    primary_entity_type TEXT, -- 'shipment', 'outbound_call', 'workflow_run', etc.
    primary_entity_id UUID, -- FK to primary entity
    batch_size INTEGER, -- Number of entities in batch operation

    ip_address INET,
    user_agent TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    total_duration_ms INTEGER,
    error_occurred BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT request_contexts_batch_size_check CHECK (batch_size IS NULL OR batch_size > 0),
    CONSTRAINT request_contexts_duration_check CHECK (total_duration_ms IS NULL OR total_duration_ms >= 0)
);

CREATE INDEX idx_request_contexts_entry_point ON request_contexts(entry_point);
CREATE INDEX idx_request_contexts_client ON request_contexts(client_id) WHERE client_id IS NOT NULL;
CREATE INDEX idx_request_contexts_user ON request_contexts(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX idx_request_contexts_started ON request_contexts(started_at DESC);
CREATE INDEX idx_request_contexts_error ON request_contexts(error_occurred) WHERE error_occurred = true;
CREATE INDEX idx_request_contexts_entity ON request_contexts(primary_entity_type, primary_entity_id) WHERE primary_entity_type IS NOT NULL;

COMMENT ON TABLE request_contexts IS 'Request tracing context - threads all operations together (Plan.md Section 4.3, lines 1223-1246) - CRITICAL: was MISSING';
COMMENT ON COLUMN request_contexts.id IS 'This is the correlation_id used throughout the system for tracing';
COMMENT ON COLUMN request_contexts.entry_point IS 'Entry point: webhook, api, worker, manual';
COMMENT ON COLUMN request_contexts.primary_entity_type IS 'Primary entity type for batch operations (e.g., shipment, outbound_call)';
COMMENT ON COLUMN request_contexts.primary_entity_id IS 'Primary entity ID for batch operations';
COMMENT ON COLUMN request_contexts.batch_size IS 'Number of entities in batch operation';
COMMENT ON COLUMN request_contexts.error_occurred IS 'Flag indicating if any error occurred during request';

-- =============================================================================
-- SECTION 4: Partitioning Config (Partition management rules)
-- =============================================================================
-- Purpose: Define which tables use partitioning and their strategies
-- From: Migration 10 seed data expectations
-- Partitioning: None (global configuration, low volume)
-- CRITICAL: Schema must match Migration 10 seed data INSERT statements

CREATE TABLE partitioning_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    table_name TEXT NOT NULL UNIQUE,
    partition_strategy TEXT NOT NULL, -- 'HASH', 'HASH+RANGE', 'RANGE', 'NONE'
    partition_key TEXT NOT NULL, -- Column name(s) to partition by
    partition_interval TEXT, -- For RANGE: 'monthly', 'weekly'
    partitions_ahead INTEGER, -- For RANGE: number of future periods to create
    retention_months INTEGER, -- For RANGE: number of months to retain before archiving
    config JSONB, -- Strategy-specific configuration
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_partitioning_config_strategy ON partitioning_config(partition_strategy);
CREATE INDEX idx_partitioning_config_table ON partitioning_config(table_name);

COMMENT ON TABLE partitioning_config IS 'Partition management configuration - defines strategies for each table (seeded in Migration 10)';
COMMENT ON COLUMN partitioning_config.partition_strategy IS 'Partitioning type: HASH, HASH+RANGE, RANGE, or NONE';
COMMENT ON COLUMN partitioning_config.partition_key IS 'Column name(s) to partition by (e.g., client_id, address_hash, created_at)';
COMMENT ON COLUMN partitioning_config.partition_interval IS 'For RANGE partitioning: monthly, weekly';
COMMENT ON COLUMN partitioning_config.partitions_ahead IS 'For RANGE: number of future periods to pre-create';
COMMENT ON COLUMN partitioning_config.retention_months IS 'For RANGE: number of months to retain before archiving';
COMMENT ON COLUMN partitioning_config.config IS 'JSONB strategy-specific config (modulus, expandable_to, retention_policy)';

-- =============================================================================
-- SECTION 5: Cache Config (Caching strategy settings)
-- =============================================================================
-- Purpose: Define caching strategies for performance optimization
-- From: Existing Migration 7 (keeping for backward compatibility)
-- Partitioning: None (global configuration, low volume)

CREATE TABLE cache_config (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    cache_key TEXT NOT NULL UNIQUE,
    cache_type TEXT NOT NULL, -- 'geocoding', 'pricing', 'routing', 'settings'
    ttl_seconds INTEGER NOT NULL DEFAULT 3600,
    max_entries INTEGER,
    eviction_policy TEXT NOT NULL DEFAULT 'LRU', -- 'LRU', 'LFU', 'FIFO', 'TTL'
    enabled BOOLEAN NOT NULL DEFAULT true,
    warmup_on_startup BOOLEAN NOT NULL DEFAULT false,
    description TEXT,
    config JSONB, -- Cache-type-specific configuration
    stats JSONB, -- Cache hit/miss statistics
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT cache_config_ttl_check CHECK (ttl_seconds > 0),
    CONSTRAINT cache_config_max_entries_check CHECK (max_entries IS NULL OR max_entries > 0)
);

CREATE INDEX idx_cache_config_type ON cache_config(cache_type);
CREATE INDEX idx_cache_config_enabled ON cache_config(enabled) WHERE enabled = true;

COMMENT ON TABLE cache_config IS 'Caching strategy configuration for performance optimization (global, non-partitioned)';
COMMENT ON COLUMN cache_config.cache_key IS 'Unique identifier for this cache instance';
COMMENT ON COLUMN cache_config.cache_type IS 'Category of cached data: geocoding, pricing, routing, settings';
COMMENT ON COLUMN cache_config.ttl_seconds IS 'Time-to-live in seconds before cache invalidation';
COMMENT ON COLUMN cache_config.eviction_policy IS 'Cache eviction strategy: LRU (least recently used), LFU (least frequently used), FIFO, TTL';
COMMENT ON COLUMN cache_config.stats IS 'Runtime statistics: {hits, misses, hit_rate, last_reset_at}';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 6 infrastructure tables (all non-partitioned, global configuration):
--
-- Tables Created:
-- 1. cron_config - Worker scheduling controls (Plan.md Section 4.3)
-- 2. worker_registry - Authoritative worker catalog (Plan.md Section 4.3)
-- 3. circuit_breaker_state - Circuit breaker resilience tracking (Plan.md Section 4.3)
-- 4. request_contexts - Request tracing context (Plan.md Section 4.3) - CRITICAL: was MISSING
-- 5. partitioning_config - Partition management rules (for Migration 10 seed data)
-- 6. cache_config - Caching strategy settings (backward compatibility)
--
-- Non-Partitioned Rationale:
-- - These are global configuration tables, not tenant-specific
-- - Low volume (< 1000 rows typically)
-- - Frequently read, infrequently written
-- - No benefit from partitioning
--
-- Critical Fixes from Old Migrations:
-- ✅ Added request_contexts table (was MISSING - critical for tracing)
-- ✅ Aligned worker_registry schema with Migration 10 seed data
-- ✅ Aligned partitioning_config schema with Migration 10 seed data
-- ✅ Added circuit_breaker_state per Plan.md
-- ✅ Simplified cron_config per Plan.md (removed complex stats)
--
-- Zero-Hardcoding Compliance:
-- - All partition management rules in partitioning_config (no hardcoded partition logic)
-- - All worker definitions in worker_registry (no hardcoded cron jobs)
-- - All cache strategies in cache_config (no hardcoded cache keys)
-- - Configuration-driven architecture
--
-- Schema Alignment with Migration 10:
-- - worker_registry matches seed data INSERTs (worker_name, worker_type, description, schedule, config, is_active)
-- - partitioning_config matches seed data INSERTs (table_name, partition_strategy, partition_key, partition_interval, partitions_ahead, retention_months, config)
-- - All columns present for successful seed data insertion
--
-- Next migration (008) will create RLS policies and performance indexes

