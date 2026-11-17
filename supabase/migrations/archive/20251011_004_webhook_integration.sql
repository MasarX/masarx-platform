-- Migration 4: Webhook Integration Tables
-- Purpose: Create 10 tables for webhook and integration management with HASH + RANGE partitioning
-- Task: 3.3 - Create Migration 4: Webhook Integration
-- Dependencies: Migration 3 (mapping, lookup)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)

-- =============================================================================
-- SECTION 1: Providers (External service providers)
-- =============================================================================

CREATE TABLE providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    provider_type TEXT NOT NULL,
    base_url TEXT,
    auth_type TEXT,
    auth_config JSONB,
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    retry_policy JSONB,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT providers_timeout_check CHECK (timeout_seconds > 0),
    CONSTRAINT providers_provider_type_check CHECK (provider_type IN ('shipping', 'geocoding', 'sms', 'webhook', 'payment'))
);

CREATE INDEX idx_providers_provider_type ON providers(provider_type);
CREATE INDEX idx_providers_is_active ON providers(is_active) WHERE is_active = true;

COMMENT ON TABLE providers IS 'External service provider definitions';
COMMENT ON COLUMN providers.auth_config IS 'JSONB authentication configuration (API keys, OAuth tokens)';
COMMENT ON COLUMN providers.retry_policy IS 'JSONB retry strategy configuration';

-- Add foreign key to mapping_configs.provider_id (from Migration 3)
ALTER TABLE mapping_configs ADD CONSTRAINT fk_mapping_configs_provider
    FOREIGN KEY (provider_id) REFERENCES providers(id);

-- Add foreign key to api_call_log.provider_id (from Migration 3)
ALTER TABLE api_call_log_p0 ADD CONSTRAINT fk_api_call_log_provider
    FOREIGN KEY (provider_id) REFERENCES providers(id);

-- =============================================================================
-- SECTION 2: Operation Templates (Reusable API operation patterns)
-- =============================================================================

CREATE TABLE operation_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT NOT NULL,
    description TEXT,
    method TEXT NOT NULL,
    endpoint_template TEXT NOT NULL,
    headers_template JSONB,
    body_template JSONB,
    response_mapping JSONB,
    timeout_override INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name),
    CONSTRAINT operation_templates_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
);

CREATE INDEX idx_operation_templates_provider_id ON operation_templates(provider_id);

COMMENT ON TABLE operation_templates IS 'Reusable API operation templates per provider';
COMMENT ON COLUMN operation_templates.endpoint_template IS 'URL template with placeholders (e.g., /shipments/{tracking_number})';
COMMENT ON COLUMN operation_templates.response_mapping IS 'JSONB rules for transforming provider response to internal format';

-- =============================================================================
-- SECTION 3: Request Templates (HTTP request patterns)
-- =============================================================================

CREATE TABLE request_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id),
    operation_template_id UUID NOT NULL REFERENCES operation_templates(id) ON DELETE CASCADE,
    template_name TEXT NOT NULL,
    header_overrides JSONB,
    body_overrides JSONB,
    query_params JSONB,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, operation_template_id, template_name)
);

CREATE INDEX idx_request_templates_client_id ON request_templates(client_id);
CREATE INDEX idx_request_templates_operation_id ON request_templates(operation_template_id);

COMMENT ON TABLE request_templates IS 'Client-specific request templates extending operation templates';
COMMENT ON COLUMN request_templates.is_default IS 'Default template for this client + operation combination';

-- =============================================================================
-- SECTION 4: Response Templates (Response parsing patterns)
-- =============================================================================

CREATE TABLE response_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id),
    operation_template_id UUID NOT NULL REFERENCES operation_templates(id) ON DELETE CASCADE,
    template_name TEXT NOT NULL,
    success_criteria JSONB NOT NULL,
    field_mappings JSONB NOT NULL,
    error_mappings JSONB,
    is_default BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, operation_template_id, template_name)
);

CREATE INDEX idx_response_templates_client_id ON response_templates(client_id);
CREATE INDEX idx_response_templates_operation_id ON response_templates(operation_template_id);

COMMENT ON TABLE response_templates IS 'Client-specific response parsing templates';
COMMENT ON COLUMN response_templates.success_criteria IS 'JSONB rules for detecting successful responses';
COMMENT ON COLUMN response_templates.field_mappings IS 'JSONB rules for extracting fields from response';

-- =============================================================================
-- SECTION 5: Circuit Breakers (Failure detection and protection)
-- =============================================================================

CREATE TABLE circuit_breakers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT,
    state TEXT NOT NULL DEFAULT 'closed',
    failure_threshold INTEGER NOT NULL DEFAULT 5,
    success_threshold INTEGER NOT NULL DEFAULT 2,
    timeout_seconds INTEGER NOT NULL DEFAULT 60,
    failure_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    half_opened_at TIMESTAMPTZ,
    next_attempt_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name),
    CONSTRAINT circuit_breakers_state_check CHECK (state IN ('closed', 'open', 'half_open')),
    CONSTRAINT circuit_breakers_failure_threshold_check CHECK (failure_threshold > 0),
    CONSTRAINT circuit_breakers_success_threshold_check CHECK (success_threshold > 0)
);

CREATE INDEX idx_circuit_breakers_provider_id ON circuit_breakers(provider_id);
CREATE INDEX idx_circuit_breakers_state ON circuit_breakers(state);
CREATE INDEX idx_circuit_breakers_next_attempt ON circuit_breakers(next_attempt_at) WHERE state = 'open';

COMMENT ON TABLE circuit_breakers IS 'Circuit breaker state tracking for provider resilience';
COMMENT ON COLUMN circuit_breakers.state IS 'closed = normal, open = failing, half_open = testing recovery';
COMMENT ON COLUMN circuit_breakers.next_attempt_at IS 'When to next attempt request in open state';

-- =============================================================================
-- SECTION 6: Provider Registry (Provider health and metrics)
-- =============================================================================

CREATE TABLE provider_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    health_status TEXT NOT NULL DEFAULT 'unknown',
    last_health_check_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    total_calls INTEGER NOT NULL DEFAULT 0,
    successful_calls INTEGER NOT NULL DEFAULT 0,
    failed_calls INTEGER NOT NULL DEFAULT 0,
    avg_response_time_ms INTEGER,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT provider_registry_health_status_check CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown'))
);

CREATE UNIQUE INDEX idx_provider_registry_provider_id ON provider_registry(provider_id);
CREATE INDEX idx_provider_registry_health_status ON provider_registry(health_status);

COMMENT ON TABLE provider_registry IS 'Provider health monitoring and metrics aggregation';
COMMENT ON COLUMN provider_registry.avg_response_time_ms IS 'Rolling average response time';

-- =============================================================================
-- SECTION 7: Webhook Configs (Webhook endpoint configurations)
-- =============================================================================

CREATE TABLE webhook_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    webhook_name TEXT NOT NULL,
    direction TEXT NOT NULL,
    url TEXT NOT NULL,
    method TEXT NOT NULL DEFAULT 'POST',
    headers JSONB,
    auth_type TEXT,
    auth_config JSONB,
    retry_policy JSONB,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, webhook_name),
    CONSTRAINT webhook_configs_direction_check CHECK (direction IN ('inbound', 'outbound')),
    CONSTRAINT webhook_configs_method_check CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'))
);

CREATE INDEX idx_webhook_configs_client_id ON webhook_configs(client_id);
CREATE INDEX idx_webhook_configs_is_active ON webhook_configs(is_active) WHERE is_active = true;

COMMENT ON TABLE webhook_configs IS 'Webhook endpoint configurations per client';
COMMENT ON COLUMN webhook_configs.direction IS 'inbound = receive webhooks, outbound = send webhooks';

-- Add foreign key to webhook_log.webhook_config_id (from Migration 3)
ALTER TABLE webhook_log_p0 ADD CONSTRAINT fk_webhook_log_config
    FOREIGN KEY (webhook_config_id) REFERENCES webhook_configs(id);

-- =============================================================================
-- SECTION 8: Webhook Rules (Event-to-webhook routing)
-- =============================================================================

CREATE TABLE webhook_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_config_id UUID NOT NULL REFERENCES webhook_configs(id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    filter_conditions JSONB,
    transformation_template JSONB,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT webhook_rules_priority_check CHECK (priority > 0)
);

CREATE INDEX idx_webhook_rules_webhook_config_id ON webhook_rules(webhook_config_id);
CREATE INDEX idx_webhook_rules_event_type ON webhook_rules(event_type);
CREATE INDEX idx_webhook_rules_is_active ON webhook_rules(is_active) WHERE is_active = true;

COMMENT ON TABLE webhook_rules IS 'Rules for routing events to webhook endpoints';
COMMENT ON COLUMN webhook_rules.filter_conditions IS 'JSONB conditions for when to trigger webhook';
COMMENT ON COLUMN webhook_rules.transformation_template IS 'JSONB template for transforming event data';

-- =============================================================================
-- SECTION 9: Webhook Events (Webhook event queue with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE webhook_events (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    webhook_config_id UUID NOT NULL REFERENCES webhook_configs(id),
    event_type TEXT NOT NULL,
    payload JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    response_status INTEGER,
    response_body JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, client_id, created_at),
    CONSTRAINT webhook_events_status_check CHECK (status IN ('pending', 'processing', 'success', 'failed', 'cancelled'))
) PARTITION BY HASH (client_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE webhook_events_p0 PARTITION OF webhook_events
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partitions (weekly, current + 3 future weeks: w41, w42, w43, w44)
CREATE TABLE webhook_events_2025_w41 PARTITION OF webhook_events_p0
    FOR VALUES FROM ('2025-10-06') TO ('2025-10-13');

CREATE TABLE webhook_events_2025_w42 PARTITION OF webhook_events_p0
    FOR VALUES FROM ('2025-10-13') TO ('2025-10-20');

CREATE TABLE webhook_events_2025_w43 PARTITION OF webhook_events_p0
    FOR VALUES FROM ('2025-10-20') TO ('2025-10-27');

CREATE TABLE webhook_events_2025_w44 PARTITION OF webhook_events_p0
    FOR VALUES FROM ('2025-10-27') TO ('2025-11-03');

-- Indexes for partitions
CREATE INDEX idx_webhook_events_2025_w41_client ON webhook_events_2025_w41(client_id);
CREATE INDEX idx_webhook_events_2025_w41_status ON webhook_events_2025_w41(status, scheduled_at);
CREATE INDEX idx_webhook_events_2025_w41_pending ON webhook_events_2025_w41(scheduled_at)
    WHERE status = 'pending';

CREATE INDEX idx_webhook_events_2025_w42_client ON webhook_events_2025_w42(client_id);
CREATE INDEX idx_webhook_events_2025_w43_client ON webhook_events_2025_w43(client_id);
CREATE INDEX idx_webhook_events_2025_w44_client ON webhook_events_2025_w44(client_id);

COMMENT ON TABLE webhook_events IS 'Webhook event queue with HASH + RANGE partitioning';
COMMENT ON COLUMN webhook_events.status IS 'pending = awaiting processing, processing = in progress, success = delivered, failed = all retries exhausted';

-- =============================================================================
-- SECTION 10: Integration Registry (Integration health tracking)
-- =============================================================================

CREATE TABLE integration_registry (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    integration_type TEXT NOT NULL,
    integration_name TEXT NOT NULL,
    provider_id UUID REFERENCES providers(id),
    webhook_config_id UUID REFERENCES webhook_configs(id),
    health_status TEXT NOT NULL DEFAULT 'unknown',
    last_health_check_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    last_failure_at TIMESTAMPTZ,
    config JSONB,
    metadata JSONB,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, integration_type, integration_name),
    CONSTRAINT integration_registry_health_status_check CHECK (health_status IN ('healthy', 'degraded', 'unhealthy', 'unknown')),
    CONSTRAINT integration_registry_integration_type_check CHECK (integration_type IN ('webhook_inbound', 'webhook_outbound', 'api_provider', 'geocoding', 'sms', 'payment'))
);

CREATE INDEX idx_integration_registry_client_id ON integration_registry(client_id);
CREATE INDEX idx_integration_registry_provider_id ON integration_registry(provider_id);
CREATE INDEX idx_integration_registry_health_status ON integration_registry(health_status);
CREATE INDEX idx_integration_registry_is_active ON integration_registry(is_active) WHERE is_active = true;

COMMENT ON TABLE integration_registry IS 'Client integration health and configuration tracking';
COMMENT ON COLUMN integration_registry.integration_type IS 'Type of integration (webhook, API, etc.)';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 10 tables for webhook and integration management:
-- 1. providers (non-partitioned)
-- 2. operation_templates (non-partitioned)
-- 3. request_templates (non-partitioned)
-- 4. response_templates (non-partitioned)
-- 5. circuit_breakers (non-partitioned)
-- 6. provider_registry (non-partitioned)
-- 7. webhook_configs (non-partitioned)
-- 8. webhook_rules (non-partitioned)
-- 9. webhook_events (HASH partitioned by client_id, RANGE partitioned by created_at weekly)
-- 10. integration_registry (non-partitioned)
--
-- Partitioning Summary:
-- - 1 HASH partition: webhook_events_p0
-- - 4 RANGE partitions: webhook_events_2025_w41/42/43/44 (weekly)
--
-- Total partitions created: 5 (1 HASH + 4 RANGE)
--
-- Foreign Keys Added:
-- - mapping_configs.provider_id → providers.id
-- - api_call_log.provider_id → providers.id
-- - webhook_log.webhook_config_id → webhook_configs.id
--
-- Zero-Hardcoding Compliance:
-- - All webhook and API behavior configured in database tables
-- - No hardcoded endpoints or credentials
-- - Flexible template system for dynamic transformations
--
-- Next migration (005) will create communications, budget, and workflow tables

