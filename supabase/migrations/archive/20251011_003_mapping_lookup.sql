-- Migration 3: Mapping, Lookup, and Observability Tables
-- Purpose: Create 9 tables for mapping configs, lookups, and observability with HASH + RANGE partitioning
-- Task: 3.2 - Create Migration 3: Mapping & Lookup
-- Dependencies: Migration 2 (configuration core)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)

-- =============================================================================
-- SECTION 1: Mapping Configurations (Field transformation rules)
-- =============================================================================

CREATE TABLE mapping_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    provider_id UUID, -- Will reference providers table (created in Migration 4)
    source_system TEXT NOT NULL,
    mapping_type TEXT NOT NULL,
    config JSONB NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT mapping_configs_priority_check CHECK (priority > 0)
);

CREATE INDEX idx_mapping_configs_client_id ON mapping_configs(client_id);
CREATE INDEX idx_mapping_configs_provider_id ON mapping_configs(provider_id);
CREATE INDEX idx_mapping_configs_is_active ON mapping_configs(is_active) WHERE is_active = true;

COMMENT ON TABLE mapping_configs IS 'Configuration for field mapping transformations per client and provider';
COMMENT ON COLUMN mapping_configs.config IS 'JSONB transformation rules for field mapping';
COMMENT ON COLUMN mapping_configs.priority IS 'Higher priority mappings override lower ones';

-- =============================================================================
-- SECTION 2: Field Mappings (Individual field transformations)
-- =============================================================================

CREATE TABLE field_mappings (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    mapping_config_id UUID NOT NULL REFERENCES mapping_configs(id) ON DELETE CASCADE,
    source_field TEXT NOT NULL,
    target_field TEXT NOT NULL,
    transformation_rule JSONB,
    required BOOLEAN NOT NULL DEFAULT false,
    default_value TEXT,
    validation_rules JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_field_mappings_config_id ON field_mappings(mapping_config_id);
CREATE INDEX idx_field_mappings_source_field ON field_mappings(source_field);

COMMENT ON TABLE field_mappings IS 'Individual field transformation rules within mapping configs';
COMMENT ON COLUMN field_mappings.transformation_rule IS 'JSONB rules for transforming source to target field';

-- =============================================================================
-- SECTION 3: Lookups (Lookup table categories)
-- =============================================================================

CREATE TABLE lookups (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    category TEXT NOT NULL UNIQUE,
    description TEXT,
    is_system BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_lookups_category ON lookups(category);

COMMENT ON TABLE lookups IS 'Lookup table categories for system and custom lookup values';
COMMENT ON COLUMN lookups.is_system IS 'System lookups cannot be deleted by users';

-- =============================================================================
-- SECTION 4: Lookup Values (Lookup entries)
-- =============================================================================

CREATE TABLE lookup_values (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    lookup_id UUID NOT NULL REFERENCES lookups(id) ON DELETE CASCADE,
    code TEXT NOT NULL,
    label_en TEXT NOT NULL,
    label_ar TEXT,
    description TEXT,
    metadata JSONB,
    sort_order INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(lookup_id, code)
);

CREATE INDEX idx_lookup_values_lookup_id ON lookup_values(lookup_id);
CREATE INDEX idx_lookup_values_code ON lookup_values(code);
CREATE INDEX idx_lookup_values_is_active ON lookup_values(is_active) WHERE is_active = true;

COMMENT ON TABLE lookup_values IS 'Individual lookup entries with multi-language support';
COMMENT ON COLUMN lookup_values.label_ar IS 'Arabic label for Saudi Arabia locale';

-- =============================================================================
-- SECTION 5: Decision Log (Audit trail with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE decision_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    decision_point TEXT NOT NULL,
    decision_made TEXT NOT NULL,
    reason JSONB,
    context JSONB,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, entity_id, created_at)
) PARTITION BY HASH (entity_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE decision_log_p0 PARTITION OF decision_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partitions (monthly, current month October 2025)
CREATE TABLE decision_log_2025_10 PARTITION OF decision_log_p0
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

CREATE INDEX idx_decision_log_2025_10_entity ON decision_log_2025_10(entity_type, entity_id);
CREATE INDEX idx_decision_log_2025_10_created ON decision_log_2025_10(created_at DESC);
CREATE INDEX idx_decision_log_2025_10_decision_point ON decision_log_2025_10(decision_point);

COMMENT ON TABLE decision_log IS 'Audit trail of automated decisions with HASH + RANGE partitioning';
COMMENT ON COLUMN decision_log.decision_point IS 'System point where decision was made (e.g., routing_engine, pricing_calculator)';
COMMENT ON COLUMN decision_log.reason IS 'JSONB explanation of decision factors';

-- =============================================================================
-- SECTION 6: Alert Rules (Monitoring alert definitions)
-- =============================================================================

CREATE TABLE alert_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id),
    rule_name TEXT NOT NULL,
    description TEXT,
    condition JSONB NOT NULL,
    severity priority_level NOT NULL DEFAULT 'medium',
    notification_channels JSONB,
    throttle_minutes INTEGER NOT NULL DEFAULT 60,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT alert_rules_throttle_check CHECK (throttle_minutes >= 0)
);

CREATE INDEX idx_alert_rules_client_id ON alert_rules(client_id);
CREATE INDEX idx_alert_rules_is_active ON alert_rules(is_active) WHERE is_active = true;
CREATE INDEX idx_alert_rules_severity ON alert_rules(severity);

COMMENT ON TABLE alert_rules IS 'Alert rule definitions for monitoring and notifications';
COMMENT ON COLUMN alert_rules.condition IS 'JSONB rule definition for when to trigger alert';
COMMENT ON COLUMN alert_rules.throttle_minutes IS 'Minimum minutes between repeated alerts';

-- =============================================================================
-- SECTION 7: Alert Triggers (Fired alerts log)
-- =============================================================================

CREATE TABLE alert_triggers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    alert_rule_id UUID NOT NULL REFERENCES alert_rules(id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL,
    entity_id UUID NOT NULL,
    severity priority_level NOT NULL,
    message TEXT NOT NULL,
    context JSONB,
    notified_at TIMESTAMPTZ,
    acknowledged_by UUID REFERENCES users(id),
    acknowledged_at TIMESTAMPTZ,
    resolution_notes TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_alert_triggers_rule_id ON alert_triggers(alert_rule_id);
CREATE INDEX idx_alert_triggers_entity ON alert_triggers(entity_type, entity_id);
CREATE INDEX idx_alert_triggers_created ON alert_triggers(created_at DESC);
CREATE INDEX idx_alert_triggers_unacknowledged ON alert_triggers(acknowledged_at) WHERE acknowledged_at IS NULL;

COMMENT ON TABLE alert_triggers IS 'Log of triggered alerts with acknowledgment tracking';

-- =============================================================================
-- SECTION 8: Webhook Log (Webhook call history with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE webhook_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    webhook_config_id UUID, -- Will reference webhook_configs (Migration 4)
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, client_id, created_at),
    CONSTRAINT webhook_log_direction_check CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT webhook_log_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
) PARTITION BY HASH (client_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE webhook_log_p0 PARTITION OF webhook_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partitions (weekly, current + 3 future weeks: w41, w42, w43, w44)
CREATE TABLE webhook_log_2025_w41 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-06') TO ('2025-10-13');

CREATE TABLE webhook_log_2025_w42 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-13') TO ('2025-10-20');

CREATE TABLE webhook_log_2025_w43 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-20') TO ('2025-10-27');

CREATE TABLE webhook_log_2025_w44 PARTITION OF webhook_log_p0
    FOR VALUES FROM ('2025-10-27') TO ('2025-11-03');

-- Indexes for each partition
CREATE INDEX idx_webhook_log_2025_w41_client ON webhook_log_2025_w41(client_id, created_at DESC);
CREATE INDEX idx_webhook_log_2025_w41_status ON webhook_log_2025_w41(response_status);
CREATE INDEX idx_webhook_log_2025_w41_direction ON webhook_log_2025_w41(direction);

CREATE INDEX idx_webhook_log_2025_w42_client ON webhook_log_2025_w42(client_id, created_at DESC);
CREATE INDEX idx_webhook_log_2025_w43_client ON webhook_log_2025_w43(client_id, created_at DESC);
CREATE INDEX idx_webhook_log_2025_w44_client ON webhook_log_2025_w44(client_id, created_at DESC);

COMMENT ON TABLE webhook_log IS 'Comprehensive webhook call history with HASH + RANGE partitioning';
COMMENT ON COLUMN webhook_log.direction IS 'inbound = received by platform, outbound = sent from platform';
COMMENT ON COLUMN webhook_log.retry_count IS 'Number of retry attempts for failed webhooks';

-- =============================================================================
-- SECTION 9: API Call Log (External API call tracking with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE api_call_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    request_id UUID NOT NULL UNIQUE,
    provider_id UUID, -- Will reference providers (Migration 4)
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
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, request_id, created_at),
    CONSTRAINT api_call_log_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
) PARTITION BY HASH (request_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE api_call_log_p0 PARTITION OF api_call_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partitions (weekly, current + 3 future weeks: w41, w42, w43, w44)
CREATE TABLE api_call_log_2025_w41 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-06') TO ('2025-10-13');

CREATE TABLE api_call_log_2025_w42 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-13') TO ('2025-10-20');

CREATE TABLE api_call_log_2025_w43 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-20') TO ('2025-10-27');

CREATE TABLE api_call_log_2025_w44 PARTITION OF api_call_log_p0
    FOR VALUES FROM ('2025-10-27') TO ('2025-11-03');

-- Indexes for each partition
CREATE INDEX idx_api_call_log_2025_w41_provider ON api_call_log_2025_w41(provider_id, created_at DESC);
CREATE INDEX idx_api_call_log_2025_w41_status ON api_call_log_2025_w41(response_status);
CREATE INDEX idx_api_call_log_2025_w41_operation ON api_call_log_2025_w41(operation);

CREATE INDEX idx_api_call_log_2025_w42_provider ON api_call_log_2025_w42(provider_id, created_at DESC);
CREATE INDEX idx_api_call_log_2025_w43_provider ON api_call_log_2025_w43(provider_id, created_at DESC);
CREATE INDEX idx_api_call_log_2025_w44_provider ON api_call_log_2025_w44(provider_id, created_at DESC);

COMMENT ON TABLE api_call_log IS 'External API call tracking with HASH + RANGE partitioning';
COMMENT ON COLUMN api_call_log.operation IS 'Logical operation name (e.g., create_shipment, get_tracking)';
COMMENT ON COLUMN api_call_log.circuit_breaker_state IS 'Circuit breaker state at time of call (open, closed, half_open)';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 9 tables for mapping, lookup, and observability:
-- 1. mapping_configs (non-partitioned)
-- 2. field_mappings (non-partitioned)
-- 3. lookups (non-partitioned)
-- 4. lookup_values (non-partitioned)
-- 5. decision_log (HASH partitioned by entity_id, RANGE partitioned by created_at monthly)
-- 6. alert_rules (non-partitioned)
-- 7. alert_triggers (non-partitioned)
-- 8. webhook_log (HASH partitioned by client_id, RANGE partitioned by created_at weekly)
-- 9. api_call_log (HASH partitioned by request_id, RANGE partitioned by created_at weekly)
--
-- Partitioning Summary:
-- - 3 HASH partitions: decision_log_p0, webhook_log_p0, api_call_log_p0
-- - 9 RANGE partitions:
--   * decision_log_2025_10 (monthly)
--   * webhook_log_2025_w41/42/43/44 (weekly)
--   * api_call_log_2025_w41/42/43/44 (weekly)
--
-- Total partitions created: 12 (3 HASH + 9 RANGE)
--
-- Zero-Hardcoding Compliance:
-- - No hardcoded client IDs or business rules
-- - All configuration driven by mapping_configs and lookups
-- - Flexible JSONB structures for dynamic behavior
--
-- Next migration (004) will create webhook integration tables

