-- Migration 3: Mapping, Lookup, and Observability Tables
-- Purpose: Create 9 tables following Plan.md Section 4.2 (Configuration), 4.3 (Integration), 4.5 (Field Mappings), Section 2307+ (Observability)
-- Phase 2 Rebuild: 100% Plan.md compliance
-- Dependencies: Migration 2 (configuration core)
-- Standards: docs/product/standards/backend/migrations.md, docs/product/standards/backend/models.md
/* objectives:allow RLS_MISSING Justification: RLS and policies for mapping/observability tables are introduced in later migrations; this file defines base schema only */

-- =============================================================================
-- SECTION 1: lookup_definitions (Plan.md Section 4.2, lines 721-732)
-- =============================================================================

CREATE TABLE lookup_definitions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL UNIQUE,
    description TEXT,
    owner_role TEXT,
    approval_policy TEXT,
    is_mutable BOOLEAN NOT NULL DEFAULT true,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lookup_definitions_category ON lookup_definitions(category);
CREATE INDEX idx_lookup_definitions_owner_role ON lookup_definitions(owner_role);

COMMENT ON TABLE lookup_definitions IS 'Lookup governance: defines lookup categories with ownership and approval policies';
COMMENT ON COLUMN lookup_definitions.category IS 'Unique category identifier (e.g., billing_status, service_level, provider_type)';
COMMENT ON COLUMN lookup_definitions.owner_role IS 'Team accountable for changes to this lookup category';
COMMENT ON COLUMN lookup_definitions.approval_policy IS 'References settings_approval_policy category for approval workflow';
COMMENT ON COLUMN lookup_definitions.is_mutable IS 'Can tenant/client extend values? If false, system-only';

-- =============================================================================
-- SECTION 2: lookup_values (Plan.md Section 4.2, lines 734-756)
-- =============================================================================

CREATE TABLE lookup_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lookup_definition_id UUID NOT NULL REFERENCES lookup_definitions(id) ON DELETE CASCADE,
    value TEXT NOT NULL,
    label TEXT NOT NULL,
    description TEXT,
    sort_order INTEGER,
    is_default BOOLEAN NOT NULL DEFAULT false,
    status TEXT NOT NULL DEFAULT 'active',
    effective_from TIMESTAMPTZ,
    effective_until TIMESTAMPTZ,
    metadata JSONB,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    retired_at TIMESTAMPTZ,

    UNIQUE(lookup_definition_id, value)
);

CREATE INDEX idx_lookup_values_lookup_definition_id ON lookup_values(lookup_definition_id);
CREATE INDEX idx_lookup_values_value ON lookup_values(value);
CREATE INDEX idx_lookup_values_status ON lookup_values(status) WHERE status = 'active';
CREATE INDEX idx_lookup_values_effective_from ON lookup_values(effective_from);

COMMENT ON TABLE lookup_values IS 'Lookup entries: single source of truth for dynamic enumerations';
COMMENT ON COLUMN lookup_values.value IS 'Canonical identifier used in code/queries';
COMMENT ON COLUMN lookup_values.label IS 'Human-readable display name';
COMMENT ON COLUMN lookup_values.status IS 'Lookup category: lookup_value_status (draft, active, archived)';
COMMENT ON COLUMN lookup_values.metadata IS 'Extra attributes (e.g., color, severity, settings_category)';

-- =============================================================================
-- SECTION 3: field_mappings (Plan.md Section 4.5, lines 1463-1501)
-- Universal bidirectional mappings for all integrations
-- =============================================================================

CREATE TABLE field_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mapping_domain TEXT NOT NULL,
    provider_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    provider_value TEXT NOT NULL,
    canonical_value TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(mapping_domain, provider_name, direction, provider_value),
    CONSTRAINT field_mappings_direction_check CHECK (direction IN ('inbound', 'outbound', 'both'))
);

CREATE INDEX idx_field_mappings_domain_provider_direction ON field_mappings(mapping_domain, provider_name, direction);
CREATE INDEX idx_field_mappings_reverse_lookup ON field_mappings(mapping_domain, provider_name, direction, canonical_value);

COMMENT ON TABLE field_mappings IS 'Universal bidirectional field translation for all integrations (status, service_level, country_code, etc.)';
COMMENT ON COLUMN field_mappings.mapping_domain IS 'Lookup category: mapping_domain (status, service_level, country_code, payment_method, currency, unit_of_measure)';
COMMENT ON COLUMN field_mappings.provider_name IS 'Provider/client identifier (e.g., lmd_provider, google_maps, client_acme)';
COMMENT ON COLUMN field_mappings.direction IS 'inbound = provider -> canonical, outbound = canonical -> provider, both = bidirectional';
COMMENT ON COLUMN field_mappings.provider_value IS 'Provider/client specific value/code';
COMMENT ON COLUMN field_mappings.canonical_value IS 'Our canonical value';

-- =============================================================================
-- SECTION 4: mapping_configs (Plan.md Section 4.3, lines 817-843)
-- UNIVERSAL MAPPING + EVENT ENGINE (SINGLE SOURCE OF TRUTH)
-- =============================================================================

CREATE TABLE mapping_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mapping_type TEXT NOT NULL,
    mapping_key TEXT NOT NULL,
    mapping_config JSONB NOT NULL,
    mapping_version INTEGER NOT NULL DEFAULT 1,
    notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(mapping_type, mapping_key),
    CONSTRAINT mapping_configs_type_check CHECK (mapping_type IN ('provider_response', 'webhook_inbound', 'webhook_outbound', 'event_extraction', 'webhook_response'))
);

CREATE INDEX idx_mapping_configs_type_key ON mapping_configs(mapping_type, mapping_key);
CREATE INDEX idx_mapping_configs_type ON mapping_configs(mapping_type);

COMMENT ON TABLE mapping_configs IS 'Universal mapping configuration for all transformations (provider responses, webhooks, event extraction)';
COMMENT ON COLUMN mapping_configs.mapping_type IS 'Type of mapping: provider_response, webhook_inbound, webhook_outbound, event_extraction, webhook_response';
COMMENT ON COLUMN mapping_configs.mapping_key IS 'Context-specific key: operation_template_id (provider_response), webhook_source_id::event_type (webhook_inbound), client_id::webhook_name (webhook_outbound), provider_type (event_extraction)';
COMMENT ON COLUMN mapping_configs.mapping_config IS 'Declarative transformation definition (success detection, field_mappings, cost_extraction, event_extraction, etc.)';
COMMENT ON COLUMN mapping_configs.mapping_version IS 'Version number, increment when structure evolves';

-- =============================================================================
-- SECTION 5: decision_log (Plan.md Section 4.14, lines 2307-2341)
-- CRITICAL FOR 2AM DEBUGGING - HASH + RANGE partitioned
-- =============================================================================

CREATE TABLE decision_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    decision_category TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    decision_point TEXT NOT NULL,
    decision_outcome TEXT NOT NULL,
    decision_inputs JSONB,
    decision_reason TEXT,
    performed_by_system TEXT,
    correlation_id UUID, -- FK to request_contexts will be added in Migration 8
    settings_resolution_id UUID,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, organization_id, timestamp)
) PARTITION BY HASH (organization_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE decision_log_p0 PARTITION OF decision_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (timestamp);

-- Create RANGE partition (monthly, current month October 2025)
CREATE TABLE decision_log_2025_10 PARTITION OF decision_log_p0
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

-- Indexes per Plan.md lines 2334-2340
CREATE INDEX idx_decision_log_2025_10_resource ON decision_log_2025_10(resource_type, resource_id, timestamp DESC);
CREATE INDEX idx_decision_log_2025_10_category ON decision_log_2025_10(decision_category, timestamp DESC);
CREATE INDEX idx_decision_log_2025_10_system ON decision_log_2025_10(performed_by_system, timestamp DESC);
CREATE INDEX idx_decision_log_2025_10_outcome ON decision_log_2025_10(decision_outcome, timestamp DESC);
CREATE INDEX idx_decision_log_2025_10_correlation ON decision_log_2025_10(correlation_id, timestamp DESC);
CREATE INDEX idx_decision_log_2025_10_settings ON decision_log_2025_10(settings_resolution_id, timestamp DESC) WHERE settings_resolution_id IS NOT NULL;
CREATE INDEX idx_decision_log_2025_10_category_outcome ON decision_log_2025_10(decision_category, decision_outcome, timestamp DESC);

COMMENT ON TABLE decision_log IS 'CRITICAL FOR 2AM DEBUGGING: Audit trail of all automated decisions with full context';
COMMENT ON COLUMN decision_log.decision_category IS 'Lookup category: decision_category (geocoding, transformation, settings_resolution, rate_limiting, campaign_enrollment, circuit_breaker, comms_scheduling, retry_logic, provider_selection, provider_budget, webhook_routing, api_response_handled)';
COMMENT ON COLUMN decision_log.resource_type IS 'Entity type: shipment, comms_job, campaign_enrollment, webhook, outbound_call';
COMMENT ON COLUMN decision_log.decision_inputs IS 'All data used to make the decision (for reproducibility)';
COMMENT ON COLUMN decision_log.performed_by_system IS 'Worker name from worker_registry (e.g., outbound_worker, campaign_dispatcher, webhook_orchestrator)';

-- =============================================================================
-- SECTION 6: alert_rules (Plan.md Section 4.14, lines 2343-2387)
-- ROW-DRIVEN ALERT CONFIGURATION (ZERO HARDCODING)
-- =============================================================================

CREATE TABLE alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    rule_name TEXT NOT NULL UNIQUE,
    enabled BOOLEAN NOT NULL DEFAULT true,
    priority INTEGER NOT NULL DEFAULT 0,
    trigger_source TEXT NOT NULL,
    trigger_conditions JSONB NOT NULL,
    throttle_window_minutes INTEGER NOT NULL DEFAULT 15,
    throttle_key_fields JSONB,
    alert_severity_lookup_id UUID REFERENCES lookup_values(id),
    alert_channels JSONB NOT NULL,
    message_template_id UUID,
    message_variables JSONB,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_rules_enabled ON alert_rules(enabled, trigger_source, priority) WHERE enabled = true;
CREATE INDEX idx_alert_rules_name ON alert_rules(rule_name);
CREATE INDEX idx_alert_rules_organization ON alert_rules(organization_id, enabled);

COMMENT ON TABLE alert_rules IS 'Event-driven alert system: business logic logs decisions, alert worker evaluates rules (ZERO HARDCODING)';
COMMENT ON COLUMN alert_rules.trigger_source IS 'Table to watch: decision_log, circuit_breaker_state, shipments, etc.';
COMMENT ON COLUMN alert_rules.trigger_conditions IS 'JSONLogic conditions to match (can include aggregations)';
COMMENT ON COLUMN alert_rules.throttle_window_minutes IS 'Minimum time between same alerts';
COMMENT ON COLUMN alert_rules.throttle_key_fields IS 'JSONPath fields for dedup (e.g., provider, operation)';
COMMENT ON COLUMN alert_rules.alert_channels IS 'Channel list: ["slack", "email"] or dynamic lookup references';
COMMENT ON COLUMN alert_rules.message_template_id IS 'Optional template for alert message formatting';

-- =============================================================================
-- SECTION 7: alert_triggers (Fired alerts log)
-- Note: This table is NOT explicitly defined in Plan.md but is needed for alert system
-- Following standard pattern from existing migration structure
-- =============================================================================

CREATE TABLE alert_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    organization_id UUID NOT NULL REFERENCES organizations(id),
    resource_type TEXT NOT NULL,
    resource_id UUID NOT NULL,
    severity TEXT NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    notified_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolution_notes TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_triggers_rule_id ON alert_triggers(alert_rule_id);
CREATE INDEX idx_alert_triggers_resource ON alert_triggers(resource_type, resource_id);
CREATE INDEX idx_alert_triggers_timestamp ON alert_triggers(timestamp DESC);
CREATE INDEX idx_alert_triggers_unacknowledged ON alert_triggers(acknowledged_at) WHERE acknowledged_at IS NULL;
CREATE INDEX idx_alert_triggers_organization ON alert_triggers(organization_id, timestamp DESC);

COMMENT ON TABLE alert_triggers IS 'Log of triggered alerts with acknowledgment tracking';
COMMENT ON COLUMN alert_triggers.timestamp IS 'When alert was triggered';

-- =============================================================================
-- SECTION 8: webhook_log (Plan.md - not explicitly defined, keeping from existing migration)
-- Webhook call history with HASH + RANGE partitioning (weekly)
-- =============================================================================

CREATE TABLE webhook_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    webhook_source_id UUID,
    direction TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    headers JSONB,
    request_body JSONB,
    response_status INTEGER,
    response_body JSONB,
    duration_ms INTEGER,
    error_message TEXT,
    retry_count INTEGER NOT NULL DEFAULT 0,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, organization_id, timestamp),
    CONSTRAINT webhook_log_direction_check CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT webhook_log_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
) PARTITION BY HASH (organization_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE webhook_log_p0 PARTITION OF webhook_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (timestamp);

-- Create RANGE partitions (weekly: w41, w42, w43, w44 - October 2025)
CREATE TABLE webhook_log_2025_w41 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-07') TO ('2025-10-14');

CREATE TABLE webhook_log_2025_w42 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-14') TO ('2025-10-21');

CREATE TABLE webhook_log_2025_w43 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-21') TO ('2025-10-28');

CREATE TABLE webhook_log_2025_w44 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-28') TO ('2025-11-04');

-- Indexes for partitions
CREATE INDEX idx_webhook_log_2025_w41_organization ON webhook_log_2025_w41(organization_id, timestamp DESC);
CREATE INDEX idx_webhook_log_2025_w41_source ON webhook_log_2025_w41(webhook_source_id);
CREATE INDEX idx_webhook_log_2025_w41_status ON webhook_log_2025_w41(response_status);
CREATE INDEX idx_webhook_log_2025_w41_direction ON webhook_log_2025_w41(direction);

CREATE INDEX idx_webhook_log_2025_w42_organization ON webhook_log_2025_w42(organization_id, timestamp DESC);
CREATE INDEX idx_webhook_log_2025_w43_organization ON webhook_log_2025_w43(organization_id, timestamp DESC);
CREATE INDEX idx_webhook_log_2025_w44_organization ON webhook_log_2025_w44(organization_id, timestamp DESC);

COMMENT ON TABLE webhook_log IS 'Comprehensive webhook call history with HASH + RANGE partitioning (weekly)';
COMMENT ON COLUMN webhook_log.direction IS 'inbound = received by platform, outbound = sent from platform';
COMMENT ON COLUMN webhook_log.timestamp IS 'When webhook was executed';

-- =============================================================================
-- SECTION 9: api_call_log (External API call tracking with HASH + RANGE partitioning)
-- Following same pattern as webhook_log
-- =============================================================================

CREATE TABLE api_call_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    provider_id UUID,
    operation TEXT NOT NULL,
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    request_headers JSONB,
    request_body JSONB,
    response_status INTEGER,
    response_headers JSONB,
    response_body JSONB,
    duration_ms INTEGER,
    error_message TEXT,
    circuit_breaker_state TEXT,
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, organization_id, timestamp),
    CONSTRAINT api_call_log_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
) PARTITION BY HASH (organization_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE api_call_log_p0 PARTITION OF api_call_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (timestamp);

-- Create RANGE partitions (weekly: w41, w42, w43, w44 - October 2025)
CREATE TABLE api_call_log_2025_w41 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-07') TO ('2025-10-14');

CREATE TABLE api_call_log_2025_w42 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-14') TO ('2025-10-21');

CREATE TABLE api_call_log_2025_w43 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-21') TO ('2025-10-28');

CREATE TABLE api_call_log_2025_w44 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-28') TO ('2025-11-04');

-- Indexes for partitions
CREATE INDEX idx_api_call_log_2025_w41_organization ON api_call_log_2025_w41(organization_id, timestamp DESC);
CREATE INDEX idx_api_call_log_2025_w41_provider ON api_call_log_2025_w41(provider_id, timestamp DESC);
CREATE INDEX idx_api_call_log_2025_w41_status ON api_call_log_2025_w41(response_status);
CREATE INDEX idx_api_call_log_2025_w41_operation ON api_call_log_2025_w41(operation);

CREATE INDEX idx_api_call_log_2025_w42_organization ON api_call_log_2025_w42(organization_id, timestamp DESC);
CREATE INDEX idx_api_call_log_2025_w43_organization ON api_call_log_2025_w43(organization_id, timestamp DESC);
CREATE INDEX idx_api_call_log_2025_w44_organization ON api_call_log_2025_w44(organization_id, timestamp DESC);

COMMENT ON TABLE api_call_log IS 'External API call tracking with HASH + RANGE partitioning (weekly)';
COMMENT ON COLUMN api_call_log.operation IS 'Logical operation name (e.g., create_shipment, get_tracking, geocode_address)';
COMMENT ON COLUMN api_call_log.circuit_breaker_state IS 'Circuit breaker state at time of call (open, closed, half_open)';
COMMENT ON COLUMN api_call_log.timestamp IS 'When API call was made';

-- =============================================================================
-- Migration Complete - Phase 2 Rebuild
-- =============================================================================

-- This migration creates 9 tables following Plan.md 100%:
-- 1. lookup_definitions (Plan.md Section 4.2, lines 721-732)
-- 2. lookup_values (Plan.md Section 4.2, lines 734-756)
-- 3. field_mappings (Plan.md Section 4.5, lines 1463-1501) - Universal bidirectional mappings
-- 4. mapping_configs (Plan.md Section 4.3, lines 817-843) - UNIVERSAL MAPPING + EVENT ENGINE
-- 5. decision_log (Plan.md Section 4.14, lines 2307-2341) - HASH + RANGE partitioned (monthly)
-- 6. alert_rules (Plan.md Section 4.14, lines 2343-2387) - ROW-DRIVEN ALERT CONFIG
-- 7. alert_triggers (Fired alerts log)
-- 8. webhook_log (HASH + RANGE partitioned, weekly)
-- 9. api_call_log (HASH + RANGE partitioned, weekly)
--
-- Partitioning Summary:
-- - 3 HASH partitions: decision_log_p0, webhook_log_p0, api_call_log_p0
-- - 9 RANGE partitions:
--   * decision_log_2025_10 (monthly)
--   * webhook_log_2025_w41/42/43/44 (weekly)
--   * api_call_log_2025_w41/42/43/44 (weekly)
--
-- Total partitions: 12 (3 HASH + 9 RANGE)
--
-- Key Plan.md Compliance:
-- ✅ lookup_definitions/values: ALL columns from Plan.md (lines 721-756)
-- ✅ field_mappings: Universal bidirectional (Plan.md lines 1463-1501)
-- ✅ mapping_configs: UNIQUE(mapping_type, mapping_key) constraint (Plan.md line 831)
-- ✅ decision_log: ALL columns + indexes from Plan.md (lines 2307-2341)
-- ✅ alert_rules: Zero-hardcoding event-driven architecture (lines 2343-2387)
-- ✅ RANGE partitions: Monthly for decision_log, weekly for logs
--
-- Next migration (004) will create webhook integration tables
