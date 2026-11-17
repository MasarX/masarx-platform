-- Migration 1: Extensions and Helper Functions
-- Purpose: Enable required PostgreSQL extensions and create ENUM types
-- Phase: 1 (MVP)
-- Dependencies: None
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes)
-- Compliance: Plan.md Section 4.1-4.2 (Extensions and helpers)

-- =============================================================================
-- SECTION 1: Enable PostgreSQL Extensions
-- =============================================================================

-- Enable pgcrypto for gen_random_uuid() and cryptographic helpers
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- Enable PostGIS for geocoding and spatial operations
CREATE EXTENSION IF NOT EXISTS "postgis";

-- Enable pg_stat_statements for query performance monitoring
CREATE EXTENSION IF NOT EXISTS "pg_stat_statements";

-- Enable pgtap for testing (Phase 1 testing infrastructure)
CREATE EXTENSION IF NOT EXISTS "pgtap";

-- =============================================================================
-- SECTION 2: Create ENUM Types for Status Fields
-- =============================================================================

-- Shipment status ENUM
-- Phase 1: Simplified statuses, enhanced workflow delivered in Phase 2
CREATE TYPE shipment_status AS ENUM (
    'pending',           -- Shipment created, awaiting processing
    'in_transit',        -- Shipment is being delivered
    'delivered',         -- Successfully delivered
    'failed',            -- Delivery attempt failed
    'cancelled',         -- Shipment cancelled
    'return_to_origin'   -- Returning to sender
);

COMMENT ON TYPE shipment_status IS 'Phase 1 simplified shipment statuses. Enhanced workflow in Phase 2 via lookup tables.';

-- Service type ENUM
-- Phase 1: ALL service types active (moved from Phase 3)
CREATE TYPE service_type AS ENUM (
    'delivery',          -- Forward delivery (warehouse to customer)
    'pickup',            -- Customer pickup (customer to warehouse)
    'swap',              -- Exchange service (drop old, pick up new)
    'return_to_origin'   -- Return to origin
);

COMMENT ON TYPE service_type IS 'All service types active in Phase 1 (delivery, pickup, swap, RTO)';

-- Priority level ENUM
-- Used for outbound queue, alerts, and workflow prioritization
CREATE TYPE priority_level AS ENUM (
    'low',
    'medium',
    'high',
    'critical'
);

COMMENT ON TYPE priority_level IS 'Priority levels for queue processing, alerts, and workflows';

-- =============================================================================
-- SECTION 3: Helper Functions for Partition Key Generation
-- =============================================================================

-- Function: generate_partition_key_hash
-- Purpose: Generate consistent hash value for HASH partitioning
-- Used by: shipments, addresses, geocoding_cache, packages, labels, settings_versions
-- Returns: Integer hash value (0 to modulus-1)
CREATE OR REPLACE FUNCTION generate_partition_key_hash(
    key_value UUID,
    modulus INTEGER DEFAULT 1
)
RETURNS INTEGER
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    -- Use hashtext on UUID string to generate consistent hash
    -- Modulo operation maps to partition number (0 to modulus-1)
    RETURN abs(hashtext(key_value::text)) % modulus;
END;
$$;

COMMENT ON FUNCTION generate_partition_key_hash IS
'Generates consistent hash value for UUID-based partition keys. Used to determine which HASH partition a record belongs to. Default MODULUS 1 allows expansion to 4, 16 without data migration.';

-- Function: generate_partition_name_range_weekly
-- Purpose: Generate partition table name for weekly RANGE partitions
-- Used by: webhook_log, api_call_log
-- Returns: Partition table name (e.g., webhook_log_2025_w41)
CREATE OR REPLACE FUNCTION generate_partition_name_range_weekly(
    base_table_name TEXT,
    partition_date TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    year_part INTEGER;
    week_part INTEGER;
BEGIN
    -- Extract ISO year and week number
    year_part := EXTRACT(ISOYEAR FROM partition_date);
    week_part := EXTRACT(WEEK FROM partition_date);

    -- Return formatted partition name: {table}_YYYY_wWW
    RETURN format('%s_%s_w%s', base_table_name, year_part, LPAD(week_part::text, 2, '0'));
END;
$$;

COMMENT ON FUNCTION generate_partition_name_range_weekly IS
'Generates partition table name for weekly RANGE partitions using ISO week number format.';

-- Function: generate_partition_name_range_monthly
-- Purpose: Generate partition table name for monthly RANGE partitions
-- Used by: decision_log, outbound_history, workflow_execution_log
-- Returns: Partition table name (e.g., decision_log_2025_10)
CREATE OR REPLACE FUNCTION generate_partition_name_range_monthly(
    base_table_name TEXT,
    partition_date TIMESTAMPTZ
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
AS $$
DECLARE
    year_part INTEGER;
    month_part INTEGER;
BEGIN
    -- Extract year and month
    year_part := EXTRACT(YEAR FROM partition_date);
    month_part := EXTRACT(MONTH FROM partition_date);

    -- Return formatted partition name: {table}_YYYY_MM
    RETURN format('%s_%s_%s', base_table_name, year_part, LPAD(month_part::text, 2, '0'));
END;
$$;

COMMENT ON FUNCTION generate_partition_name_range_monthly IS
'Generates partition table name for monthly RANGE partitions with zero-padded month.';

-- =============================================================================
-- Migration 1 Complete
-- =============================================================================

-- Summary:
-- - 4 PostgreSQL extensions enabled (pgcrypto, postgis, pg_stat_statements, pgtap)
-- - 3 ENUM types created (shipment_status, service_type, priority_level)
-- - 3 helper functions for partition key generation
--
-- Next migration (002) will create 10 configuration core tables

