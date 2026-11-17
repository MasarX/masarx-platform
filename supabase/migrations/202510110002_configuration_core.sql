-- Migration 2: Configuration Core Tables (10 Tables)
-- Purpose: Create core configuration tables for identity, authorization, and dynamic configuration
-- Phase: 1 (MVP)
-- Dependencies: Migration 1 (extensions)
-- Follows: docs/product/standards/backend/migrations.md (small, focused, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)
-- Compliance: Plan.md Section 4.1 (Identity & Authorization) + Section 4.2 (Configuration)
/* objectives:allow RLS_MISSING Justification: RLS and policies for these core tables are enabled in later migrations; this file captures initial schema only */

-- =============================================================================
-- SECTION 1: Organizations (Root tenant entity)
-- =============================================================================

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    timezone TEXT NOT NULL DEFAULT 'Asia/Riyadh',
    locale TEXT NOT NULL DEFAULT 'ar-SA',
    default_settings JSONB,
    billing_status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT organizations_slug_check CHECK (slug ~ '^[a-z0-9-]+$')
);

CREATE INDEX idx_organizations_billing_status ON organizations(billing_status);

COMMENT ON TABLE organizations IS 'Root tenant entity representing top-level organizations. Equivalent to tenant in Plan.md.';
COMMENT ON COLUMN organizations.slug IS 'URL-safe identifier for organization';
COMMENT ON COLUMN organizations.timezone IS 'Default timezone (Asia/Riyadh for Saudi Arabia)';
COMMENT ON COLUMN organizations.locale IS 'Default locale (ar-SA for Arabic, en-US for English)';
COMMENT ON COLUMN organizations.default_settings IS 'Tenant-wide default configuration settings';
COMMENT ON COLUMN organizations.billing_status IS 'Lookup category: billing_status (active, suspended, trial)';

-- =============================================================================
-- SECTION 2: Users (Supabase auth integration)
-- =============================================================================

CREATE TABLE users (
    id UUID PRIMARY KEY, -- References Supabase auth.users.id (no DEFAULT, set by application)
    organization_id UUID NOT NULL REFERENCES organizations(id),
    email TEXT NOT NULL UNIQUE,
    full_name TEXT NOT NULL,
    user_type TEXT NOT NULL DEFAULT 'ops_admin',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_login_at TIMESTAMPTZ,

    CONSTRAINT users_email_check CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE INDEX idx_users_organization_id ON users(organization_id);
CREATE INDEX idx_users_status ON users(status) WHERE status = 'active';

COMMENT ON TABLE users IS 'Application users linked to Supabase authentication';
COMMENT ON COLUMN users.id IS 'References auth.users.id in Supabase auth schema';
COMMENT ON COLUMN users.user_type IS 'Lookup category: user_type. Phase 1: ops_admin, account_manager, super_admin. Phase 2: driver, dispatcher';
COMMENT ON COLUMN users.status IS 'Lookup category: user_status (active, suspended)';

-- =============================================================================
-- SECTION 3: Clients (Core customer entity)
-- =============================================================================

CREATE TABLE clients (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    account_manager_id UUID REFERENCES users(id),
    contract_start_date DATE,
    contract_end_date DATE,
    sla_tier TEXT NOT NULL DEFAULT 'standard',
    warehouse_address_id UUID, -- FK will be added after addresses table created in migration 6
    billing_settings JSONB,
    status TEXT NOT NULL DEFAULT 'active',
    suspension_reason TEXT,
    settings_override JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(organization_id, slug),
    CONSTRAINT clients_slug_check CHECK (slug ~ '^[a-z0-9-]+$'),
    CONSTRAINT clients_contract_dates_check CHECK (contract_end_date IS NULL OR contract_end_date >= contract_start_date)
);

CREATE INDEX idx_clients_organization_id ON clients(organization_id);
CREATE INDEX idx_clients_account_manager_id ON clients(account_manager_id);
CREATE INDEX idx_clients_status ON clients(status);

COMMENT ON TABLE clients IS 'Customer accounts that use the platform';
COMMENT ON COLUMN clients.slug IS 'URL-safe identifier unique within organization';
COMMENT ON COLUMN clients.sla_tier IS 'Lookup category: sla_tier (economy, standard, premium)';
COMMENT ON COLUMN clients.warehouse_address_id IS 'Default warehouse for shipment pickups (ops team only). FK added in migration 6.';
COMMENT ON COLUMN clients.status IS 'Lookup category: client_status (active, suspended, terminated)';
COMMENT ON COLUMN clients.settings_override IS 'Client-specific configuration overrides';

-- =============================================================================
-- SECTION 4: Senders (Auto-provisioned shipment sources)
-- =============================================================================

CREATE TABLE senders (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    name TEXT NOT NULL,
    brand_name TEXT,
    auto_provisioned BOOLEAN NOT NULL DEFAULT false,
    auto_recreate BOOLEAN NOT NULL DEFAULT true,
    warehouse_address_id UUID, -- FK will be added after addresses table created in migration 6
    settings_override JSONB,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_senders_client_id ON senders(client_id);
CREATE INDEX idx_senders_status ON senders(status);
CREATE INDEX idx_senders_auto_provisioned ON senders(auto_provisioned) WHERE auto_provisioned = true;

COMMENT ON TABLE senders IS 'Shipment sources within a client account, auto-provisioned from webhooks';
COMMENT ON COLUMN senders.auto_provisioned IS 'Created automatically on first webhook arrival';
COMMENT ON COLUMN senders.auto_recreate IS 'Recreate if deleted and webhook arrives (default true for resilience)';
COMMENT ON COLUMN senders.warehouse_address_id IS 'Sender-specific warehouse, overrides client warehouse (ops team only). FK added in migration 6.';
COMMENT ON COLUMN senders.status IS 'Lookup category: sender_status (active, inactive)';
COMMENT ON COLUMN senders.settings_override IS 'Sender-specific configuration overrides';

-- =============================================================================
-- SECTION 5: Schema Registry (Configuration schema definitions)
-- =============================================================================

CREATE TABLE schema_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL,
    version INTEGER NOT NULL,
    schema JSONB NOT NULL,
    description TEXT,
    examples JSONB,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    deprecated_at TIMESTAMPTZ,

    UNIQUE(category, version)
);

CREATE INDEX idx_schema_registry_category ON schema_registry(category);
CREATE INDEX idx_schema_registry_is_active ON schema_registry(is_active) WHERE is_active = true;

COMMENT ON TABLE schema_registry IS 'JSON Schema definitions for configuration categories';
COMMENT ON COLUMN schema_registry.category IS 'Configuration category (e.g., import_mapping, geocoding_policy)';
COMMENT ON COLUMN schema_registry.schema IS 'JSON Schema definition for validation';
COMMENT ON COLUMN schema_registry.examples IS 'Example valid configurations';

-- =============================================================================
-- SECTION 6: Settings Versions (Versioned configuration with HASH partitioning)
-- =============================================================================

-- Create partitioned table
-- NOTE: Partitioned by client_id per Plan.md Section 4.2
-- MODULUS 1 allows expansion to 4, 16 without data migration
CREATE TABLE settings_versions (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    category TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id UUID,
    version INTEGER NOT NULL,
    value JSONB NOT NULL,
    schema_version INTEGER,
    change_reason TEXT,
    requested_by UUID REFERENCES users(id),
    approved_by UUID REFERENCES users(id),
    approved_at TIMESTAMPTZ,
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, scope_id),
    CONSTRAINT settings_versions_effective_dates_check CHECK (effective_until IS NULL OR effective_until > effective_from)
) PARTITION BY HASH (scope_id);

-- Create default partition (MODULUS 1 for future expansion)
CREATE TABLE settings_versions_p0 PARTITION OF settings_versions
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX idx_settings_versions_p0_scope_id ON settings_versions_p0(scope_id);
CREATE INDEX idx_settings_versions_p0_category ON settings_versions_p0(category);
CREATE INDEX idx_settings_versions_p0_scope ON settings_versions_p0(scope_type, scope_id);
CREATE INDEX idx_settings_versions_p0_effective ON settings_versions_p0(effective_from, effective_until);
CREATE UNIQUE INDEX idx_settings_versions_p0_current ON settings_versions_p0(category, scope_type, scope_id)
    WHERE effective_until IS NULL AND approved_at IS NOT NULL;

COMMENT ON TABLE settings_versions IS 'Versioned configuration settings with approval workflow and HASH partitioning by scope_id (client_id, sender_id, etc.)';
COMMENT ON COLUMN settings_versions.category IS 'Configuration category (references schema_registry.category)';
COMMENT ON COLUMN settings_versions.scope_type IS 'Lookup category: scope_type (global, tenant, client, sender, role, user, resource)';
COMMENT ON COLUMN settings_versions.scope_id IS 'UUID of scoped entity (client_id, sender_id, user_id, etc.). Used as partition key.';
COMMENT ON COLUMN settings_versions.value IS 'Configuration value as JSON (validated against schema_registry)';
COMMENT ON COLUMN settings_versions.effective_from IS 'When this configuration version becomes active';
COMMENT ON COLUMN settings_versions.effective_until IS 'When this configuration version expires (NULL = current)';

-- =============================================================================
-- SECTION 7: Settings (Active view - denormalized for performance)
-- =============================================================================

CREATE TABLE settings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL,
    scope_type TEXT NOT NULL,
    scope_id UUID,
    settings_version_id UUID NOT NULL,
    cached_value JSONB NOT NULL,
    last_updated TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(category, scope_type, scope_id)
);

CREATE INDEX idx_settings_category ON settings(category);
CREATE INDEX idx_settings_scope ON settings(scope_type, scope_id);

COMMENT ON TABLE settings IS 'Active view of current settings (denormalized for fast reads)';
COMMENT ON COLUMN settings.settings_version_id IS 'Points to current active version in settings_versions';
COMMENT ON COLUMN settings.cached_value IS 'Denormalized configuration value for fast reads (avoid JOIN)';

-- =============================================================================
-- SECTION 8: Settings Approval Queue (Approval workflow queue)
-- =============================================================================

CREATE TABLE settings_approval_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settings_version_id UUID NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    dry_run_results JSONB,
    blast_radius JSONB,
    approvals JSONB[],
    rejection_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    resolved_at TIMESTAMPTZ
);

CREATE INDEX idx_settings_approval_queue_status ON settings_approval_queue(status) WHERE status = 'pending';
CREATE INDEX idx_settings_approval_queue_settings_version ON settings_approval_queue(settings_version_id);

COMMENT ON TABLE settings_approval_queue IS 'Approval workflow queue for settings changes';
COMMENT ON COLUMN settings_approval_queue.status IS 'Lookup category: approval_status (pending, approved, rejected, withdrawn)';
COMMENT ON COLUMN settings_approval_queue.dry_run_results IS 'Impact simulation output from dry run';
COMMENT ON COLUMN settings_approval_queue.blast_radius IS 'Estimated affected resources (shipments, clients, etc.)';
COMMENT ON COLUMN settings_approval_queue.approvals IS 'Array of approval objects: [{user_id, role, approved_at}]';

-- =============================================================================
-- SECTION 9: Feature Flags (Feature toggle system)
-- =============================================================================

CREATE TABLE feature_flags (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    scope_type TEXT NOT NULL,
    scope_id UUID,
    enabled BOOLEAN NOT NULL DEFAULT false,
    rollout_percentage INTEGER NOT NULL DEFAULT 0,
    conditions JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT feature_flags_rollout_percentage_check CHECK (rollout_percentage BETWEEN 0 AND 100)
);

CREATE INDEX idx_feature_flags_scope ON feature_flags(scope_type, scope_id);
CREATE INDEX idx_feature_flags_enabled ON feature_flags(enabled) WHERE enabled = true;

COMMENT ON TABLE feature_flags IS 'Feature toggle system for gradual rollout and A/B testing';
COMMENT ON COLUMN feature_flags.scope_type IS 'Lookup category: feature_flag_scope (global, tenant, client)';
COMMENT ON COLUMN feature_flags.rollout_percentage IS 'Gradual rollout percentage (0-100)';
COMMENT ON COLUMN feature_flags.conditions IS 'Additional JSONLogic rules for feature activation';

-- =============================================================================
-- SECTION 10: Settings Change Log (Audit trail for configuration changes)
-- =============================================================================

CREATE TABLE settings_change_log (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    settings_version_id UUID NOT NULL,
    action TEXT NOT NULL,
    performed_by UUID NOT NULL REFERENCES users(id),
    reason TEXT,
    previous_version_id UUID,
    killer_switch_triggered BOOLEAN NOT NULL DEFAULT false,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_settings_change_log_settings_version ON settings_change_log(settings_version_id);
CREATE INDEX idx_settings_change_log_performed_by ON settings_change_log(performed_by);
CREATE INDEX idx_settings_change_log_timestamp ON settings_change_log(timestamp DESC);
CREATE INDEX idx_settings_change_log_killer_switch ON settings_change_log(killer_switch_triggered) WHERE killer_switch_triggered = true;

COMMENT ON TABLE settings_change_log IS 'Audit trail for all configuration changes';
COMMENT ON COLUMN settings_change_log.action IS 'Lookup category: settings_audit_action (created, approved, applied, rolled_back, reverted)';
COMMENT ON COLUMN settings_change_log.killer_switch_triggered IS 'Auto-rollback flag (true if killer switch activated)';
COMMENT ON COLUMN settings_change_log.previous_version_id IS 'References previous settings_version for rollback tracing';

-- =============================================================================
-- Migration 2 Complete
-- =============================================================================

-- Summary:
-- This migration creates 10 configuration core tables from Plan.md Section 4.1-4.2:
--
-- Identity & Authorization (4 tables):
-- 1. organizations (root tenant)
-- 2. users (auth integration)
-- 3. clients (customer accounts)
-- 4. senders (shipment sources)
--
-- Configuration - The Dynamic Brain (6 tables):
-- 5. schema_registry (config schemas)
-- 6. settings_versions (versioned config, HASH partitioned by scope_id, MODULUS 1)
-- 7. settings (active view)
-- 8. settings_approval_queue (approval workflow)
-- 9. feature_flags (feature toggles)
-- 10. settings_change_log (audit trail)
--
-- HASH Partitioning:
-- - settings_versions: Partitioned by scope_id (MODULUS 1, expandable to 4, 16)
-- - Current: 1 default partition (settings_versions_p0)
--
-- Zero-Hardcoding Compliance:
-- - No client IDs in code
-- - All business logic will live in settings_versions
-- - Configuration schemas defined in schema_registry
-- - No hardcoded business rules in migrations
-- - All lookups use text references to lookup tables (created in migration 3)
--
-- Phase Notes:
-- - roles, permissions, user_roles DEFERRED to Phase 2 (not in Phase 1 10 tables per Plan.md)
-- - warehouse_address_id FKs will be added in migration 8 after addresses table exists
--
-- Next migration (003) will create mapping, lookup, and observability tables
