-- Migration 8: RLS Policies and Performance Indexes
-- Purpose: Enable Row-Level Security policies and create performance indexes
-- Task: 5.2 - Create Migration 8: RLS & Indexes
-- Dependencies: Migration 7 (infrastructure)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, index management)
-- Follows: docs/product/standards/backend/models.md (indexes on foreign keys, frequently queried fields)

-- =============================================================================
-- SECTION 1: Enable Row-Level Security (RLS) on Tables
-- =============================================================================

-- Enable RLS on shipments (multi-tenant isolation by client_id)
ALTER TABLE shipments ENABLE ROW LEVEL SECURITY;

-- Enable RLS on addresses (multi-tenant isolation by client_id)
ALTER TABLE addresses ENABLE ROW LEVEL SECURITY;

-- Enable RLS on packages (multi-tenant isolation via shipment → client)
ALTER TABLE packages ENABLE ROW LEVEL SECURITY;

-- Enable RLS on labels (multi-tenant isolation via shipment → client)
ALTER TABLE labels ENABLE ROW LEVEL SECURITY;

-- Enable RLS on settings_versions (multi-tenant isolation by client_id)
ALTER TABLE settings_versions ENABLE ROW LEVEL SECURITY;

-- Enable RLS on decision_log (multi-tenant isolation via entity reference)
ALTER TABLE decision_log ENABLE ROW LEVEL SECURITY;

-- Enable RLS on webhook_log (multi-tenant isolation by client_id)
ALTER TABLE webhook_log ENABLE ROW LEVEL SECURITY;

-- Enable RLS on outbound_history (multi-tenant isolation by client_id)
ALTER TABLE outbound_history ENABLE ROW LEVEL SECURITY;

-- Enable RLS on workflow_execution_log (multi-tenant isolation via shipment → client)
ALTER TABLE workflow_execution_log ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE shipments IS 'Core shipment records with HASH partitioning by client_id (RLS enabled)';
COMMENT ON TABLE addresses IS 'Multi-purpose address records with HASH partitioning by client_id (RLS enabled)';

-- =============================================================================
-- SECTION 2: Create RLS Policies for Multi-Tenant Data Isolation
-- =============================================================================

-- Policy for shipments: Users can only access shipments from their client
CREATE POLICY shipments_tenant_isolation ON shipments
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for addresses: Users can only access addresses from their client
CREATE POLICY addresses_tenant_isolation ON addresses
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for packages: Users can only access packages from their client's shipments
CREATE POLICY packages_tenant_isolation ON packages
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for labels: Users can only access labels from their client's shipments
CREATE POLICY labels_tenant_isolation ON labels
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for settings_versions: Users can only access settings for their client
CREATE POLICY settings_versions_tenant_isolation ON settings_versions
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for decision_log: Access based on entity ownership
-- Note: Simplified policy - can be enhanced with entity-specific checks
CREATE POLICY decision_log_tenant_isolation ON decision_log
    USING (true); -- Open for now, will be refined based on entity_type routing

-- Policy for webhook_log: Users can only access webhook logs from their client
CREATE POLICY webhook_log_tenant_isolation ON webhook_log
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for outbound_history: Users can only access outbound history from their client
CREATE POLICY outbound_history_tenant_isolation ON outbound_history
    USING (
        client_id = COALESCE(
            current_setting('request.jwt.claims', true)::json->>'client_id',
            current_setting('app.current_client_id', true)
        )::uuid
    );

-- Policy for workflow_execution_log: Access based on shipment ownership
-- Note: Simplified policy using direct access for now
CREATE POLICY workflow_execution_log_tenant_isolation ON workflow_execution_log
    USING (true); -- Open for now, will be refined with shipment joins

COMMENT ON POLICY shipments_tenant_isolation ON shipments IS
    'Isolate shipments by client_id from JWT claims or session variable';
COMMENT ON POLICY addresses_tenant_isolation ON addresses IS
    'Isolate addresses by client_id from JWT claims or session variable';

-- =============================================================================
-- SECTION 3: Performance Indexes
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Shipments Indexes (most queried table)
-- -----------------------------------------------------------------------------

-- Index 1: Tracking number lookup (already exists as UNIQUE in Migration 6, verify here)
-- CREATE INDEX IF NOT EXISTS idx_shipments_p0_tracking ON shipments_p0(tracking_number);

-- Index 2: Client + status composite for filtered client queries
-- CREATE INDEX IF NOT EXISTS idx_shipments_p0_client_status ON shipments_p0(client_id, status);

-- Index 3: Created timestamp DESC for recent shipments queries
-- CREATE INDEX IF NOT EXISTS idx_shipments_p0_created ON shipments_p0(created_at DESC);

-- Note: Above indexes already created in Migration 6, documented here for completeness

-- -----------------------------------------------------------------------------
-- Addresses Indexes (geocoding lookups)
-- -----------------------------------------------------------------------------

-- Index 4: Postal code + city for geocoding lookups
-- CREATE INDEX IF NOT EXISTS idx_addresses_p0_geocoding ON addresses_p0(postal_code, city);

-- Index 5: Client + address type for client address queries
CREATE INDEX IF NOT EXISTS idx_addresses_p0_client_type ON addresses_p0(client_id, address_type);

-- Note: Spatial index on location already created in Migration 6

-- -----------------------------------------------------------------------------
-- Geocoding Cache Indexes (performance critical)
-- -----------------------------------------------------------------------------

-- Index 6-9: Address hash for cache lookups (already created in Migration 6 for all partitions)
-- CREATE INDEX IF NOT EXISTS idx_geocoding_cache_p0_hash ON geocoding_cache_p0(address_hash);
-- CREATE INDEX IF NOT EXISTS idx_geocoding_cache_p1_hash ON geocoding_cache_p1(address_hash);
-- CREATE INDEX IF NOT EXISTS idx_geocoding_cache_p2_hash ON geocoding_cache_p2(address_hash);
-- CREATE INDEX IF NOT EXISTS idx_geocoding_cache_p3_hash ON geocoding_cache_p3(address_hash);

-- Index 10-13: Postal code for fallback lookups (already created in Migration 6)
-- CREATE INDEX IF NOT EXISTS idx_geocoding_cache_p0_postal ON geocoding_cache_p0(postal_code);

-- -----------------------------------------------------------------------------
-- Webhook Log Indexes (debugging)
-- -----------------------------------------------------------------------------

-- Index 14: Client + created_at for client webhook history
CREATE INDEX IF NOT EXISTS idx_webhook_log_2025_w41_client_created ON webhook_log_2025_w41(client_id, created_at DESC);

-- Index 15: Response status for error analysis (already created in Migration 3)
-- CREATE INDEX IF NOT EXISTS idx_webhook_log_2025_w41_status ON webhook_log_2025_w41(response_status);

-- -----------------------------------------------------------------------------
-- Decision Log Indexes (audit trail)
-- -----------------------------------------------------------------------------

-- Index 16: Entity type + entity ID for entity lookup
-- CREATE INDEX IF NOT EXISTS idx_decision_log_2025_10_entity ON decision_log_2025_10(entity_type, entity_id);

-- Index 17: Created timestamp DESC for recent decisions
-- CREATE INDEX IF NOT EXISTS idx_decision_log_2025_10_created ON decision_log_2025_10(created_at DESC);

-- Note: Above indexes already created in Migration 3

-- -----------------------------------------------------------------------------
-- API Call Log Indexes (monitoring)
-- -----------------------------------------------------------------------------

-- Index 18: Provider + created_at for provider performance monitoring
-- CREATE INDEX IF NOT EXISTS idx_api_call_log_2025_w41_provider ON api_call_log_2025_w41(provider_id, created_at DESC);

-- Index 19: Status code for error analysis
-- CREATE INDEX IF NOT EXISTS idx_api_call_log_2025_w41_status ON api_call_log_2025_w41(response_status);

-- Note: Above indexes already created in Migration 3

-- -----------------------------------------------------------------------------
-- Outbound Queue Indexes (worker processing)
-- -----------------------------------------------------------------------------

-- Index 20: Status + scheduled_at for worker queue processing
-- CREATE INDEX IF NOT EXISTS idx_outbound_queue_p0_status ON outbound_queue_p0(status, scheduled_at);

-- Index 21: Priority DESC + created_at for priority queue
-- CREATE INDEX IF NOT EXISTS idx_outbound_queue_p0_priority ON outbound_queue_p0(priority DESC, created_at);

-- Note: Above indexes already created in Migration 5

-- -----------------------------------------------------------------------------
-- Outbound History Indexes (audit)
-- -----------------------------------------------------------------------------

-- Index 22: Shipment + created_at for shipment message history
-- CREATE INDEX IF NOT EXISTS idx_outbound_history_2025_10_shipment ON outbound_history_2025_10(shipment_id, created_at DESC);

-- Note: Above index already created in Migration 5

-- -----------------------------------------------------------------------------
-- Workflow Execution Log Indexes (debugging)
-- -----------------------------------------------------------------------------

-- Index 23: Shipment + created_at for shipment workflow history
-- CREATE INDEX IF NOT EXISTS idx_workflow_execution_log_2025_10_shipment ON workflow_execution_log_2025_10(shipment_id, created_at DESC);

-- Note: Above index already created in Migration 5

-- =============================================================================
-- SECTION 4: Additional Performance Indexes (New in this migration)
-- =============================================================================

-- Index for packages by shipment (already exists in Migration 6)
-- CREATE INDEX IF NOT EXISTS idx_packages_p0_shipment_id ON packages_p0(shipment_id);

-- Index for labels by shipment (already exists in Migration 6)
-- CREATE INDEX IF NOT EXISTS idx_labels_p0_shipment_id ON labels_p0(shipment_id);

-- Index for user_roles by user_id (already exists in Migration 2)
-- CREATE INDEX IF NOT EXISTS idx_user_roles_p0_user_id ON user_roles_p0(user_id);

-- Index for settings_versions by client_id (already exists in Migration 2)
-- CREATE INDEX IF NOT EXISTS idx_settings_versions_p0_client_id ON settings_versions_p0(client_id);

-- New index: Outbound queue pending messages (critical for worker performance)
CREATE INDEX IF NOT EXISTS idx_outbound_queue_p0_pending_priority ON outbound_queue_p0(scheduled_at, priority DESC)
    WHERE status = 'pending';

-- New index: Shipments by sender for sender analytics
CREATE INDEX IF NOT EXISTS idx_shipments_p0_sender_created ON shipments_p0(sender_id, created_at DESC)
    WHERE sender_id IS NOT NULL;

-- New index: Webhook events pending processing
CREATE INDEX IF NOT EXISTS idx_webhook_events_2025_w41_pending ON webhook_events_2025_w41(scheduled_at, priority DESC)
    WHERE status = 'pending';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration enables RLS and creates performance indexes:
--
-- RLS Policies Created: 9
-- 1. shipments_tenant_isolation
-- 2. addresses_tenant_isolation
-- 3. packages_tenant_isolation
-- 4. labels_tenant_isolation
-- 5. settings_versions_tenant_isolation
-- 6. decision_log_tenant_isolation
-- 7. webhook_log_tenant_isolation
-- 8. outbound_history_tenant_isolation
-- 9. workflow_execution_log_tenant_isolation
--
-- Performance Indexes:
-- - Most indexes already created in Migrations 2, 3, 5, 6
-- - 3 new indexes added in this migration:
--   * idx_addresses_p0_client_type
--   * idx_outbound_queue_p0_pending_priority (partial index for worker queue)
--   * idx_shipments_p0_sender_created (partial index for sender analytics)
--   * idx_webhook_events_2025_w41_pending (partial index for webhook processing)
--
-- Total Indexed Columns: 17+ (many already created in previous migrations)
--
-- Critical Indexes for Performance:
-- - tracking_number (shipments): Fast shipment lookup
-- - client_id + status (shipments): Filtered client queries
-- - address_hash (geocoding_cache): Cache lookup
-- - postal_code (geocoding_cache, addresses): Geocoding fallback
-- - pending status (outbound_queue, webhook_events): Worker queue processing
--
-- Multi-Tenant Isolation:
-- - RLS enabled on all critical tables
-- - Policies use JWT claims or session variables for client_id
-- - Simplified policies for decision_log and workflow_execution_log (to be refined)
--
-- Next migration (009) will create partition management functions

