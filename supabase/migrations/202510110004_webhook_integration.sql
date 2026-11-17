-- Migration 4: Webhook Integration Tables
-- Purpose: Create 10 tables following Plan.md Section 4.3 (Integration - Provider-Agnostic) and 4.4 (Webhooks)
-- Phase 2 Rebuild: 100% Plan.md compliance
-- Dependencies: Migration 3 (mapping, lookup, observability)
-- Standards: docs/product/standards/backend/migrations.md, docs/product/standards/backend/models.md
/* objectives:allow RLS_MISSING Justification: RLS and policies for webhook integration tables are configured in subsequent migrations; this migration sets up initial tables only */

-- =============================================================================
-- SECTION 1: providers (Plan.md Section 4.3, lines 759-771)
-- =============================================================================

CREATE TABLE providers (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    priority_rank INTEGER NOT NULL DEFAULT 100,
    health_status TEXT NOT NULL DEFAULT 'healthy',
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_providers_organization_id ON providers(organization_id);
CREATE INDEX idx_providers_type ON providers(provider_type);
CREATE INDEX idx_providers_enabled ON providers(enabled) WHERE enabled = true;
CREATE INDEX idx_providers_priority ON providers(priority_rank);
CREATE INDEX idx_providers_health ON providers(health_status);

COMMENT ON TABLE providers IS 'External service providers (comms, geocoding, routing, webhook, payment, delivery)';
COMMENT ON COLUMN providers.name IS 'Provider identifier (e.g., twilio_sms, google_geocoding)';
COMMENT ON COLUMN providers.provider_type IS 'Lookup category: provider_type (comms, geocoding, routing, webhook, payment, delivery)';
COMMENT ON COLUMN providers.priority_rank IS 'For fallback ordering (higher = try first)';
COMMENT ON COLUMN providers.health_status IS 'Lookup category: component_health_status (healthy, degraded, down)';

-- =============================================================================
-- SECTION 2: provider_auth_configs (Plan.md Section 4.3, lines 773-790)
-- SIMPLIFIED per Plan.md
-- =============================================================================

CREATE TABLE provider_auth_configs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    auth_type TEXT NOT NULL,
    credentials JSONB NOT NULL,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_provider_auth_configs_provider_id ON provider_auth_configs(provider_id);
CREATE INDEX idx_provider_auth_configs_expires_at ON provider_auth_configs(expires_at);

COMMENT ON TABLE provider_auth_configs IS 'Authentication credentials for providers (outbound API calls AND inbound webhook verification)';
COMMENT ON COLUMN provider_auth_configs.auth_type IS 'Lookup category: provider_auth_type (api_key, oauth2, bearer_token, basic_auth, hmac, custom)';
COMMENT ON COLUMN provider_auth_configs.credentials IS 'Encrypted credentials (API keys, tokens, secrets)';
COMMENT ON COLUMN provider_auth_configs.expires_at IS 'Token expiration timestamp (for awareness, create new entry when expired)';

-- =============================================================================
-- SECTION 3: operation_templates (Plan.md Section 4.3, lines 792-815)
-- =============================================================================

CREATE TABLE operation_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT NOT NULL,
    method TEXT NOT NULL,
    url_template TEXT NOT NULL,
    headers_template JSONB,
    body_template JSONB,
    request_mappings JSONB,
    mapping_config_id UUID NOT NULL REFERENCES mapping_configs(id),
    timeout_seconds INTEGER NOT NULL DEFAULT 30,
    idempotency_key_template TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name),
    CONSTRAINT operation_templates_timeout_check CHECK (timeout_seconds > 0)
);

CREATE INDEX idx_operation_templates_provider_id ON operation_templates(provider_id);
CREATE INDEX idx_operation_templates_operation_name ON operation_templates(operation_name);
CREATE INDEX idx_operation_templates_mapping_config_id ON operation_templates(mapping_config_id);

COMMENT ON TABLE operation_templates IS 'HTTP spec for each provider operation (ZERO HARDCODING)';
COMMENT ON COLUMN operation_templates.operation_name IS 'Operation identifier (e.g., send_sms, geocode_address, create_shipment)';
COMMENT ON COLUMN operation_templates.method IS 'Lookup category: http_method (GET, POST, PUT, DELETE)';
COMMENT ON COLUMN operation_templates.url_template IS 'URL with placeholders: https://api.provider.com/{version}/sms';
COMMENT ON COLUMN operation_templates.request_mappings IS 'JSONPath transformations for request';
COMMENT ON COLUMN operation_templates.mapping_config_id IS 'REQUIRED: How to parse response (FK to mapping_configs)';

-- =============================================================================
-- SECTION 4: rate_limits (Plan.md Section 4.3, lines 845-862)
-- Technical rate limiting ONLY (not cost)
-- =============================================================================

CREATE TABLE rate_limits (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT,
    window_type TEXT NOT NULL,
    window_size INTEGER NOT NULL,
    max_requests INTEGER NOT NULL,
    burst_allowance INTEGER,
    backoff_strategy TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT rate_limits_window_size_check CHECK (window_size > 0),
    CONSTRAINT rate_limits_max_requests_check CHECK (max_requests > 0)
);

CREATE INDEX idx_rate_limits_provider_id ON rate_limits(provider_id);
CREATE INDEX idx_rate_limits_provider_operation ON rate_limits(provider_id, operation_name);

COMMENT ON TABLE rate_limits IS 'Technical rate limiting ONLY (requests per second/minute) - cost tracking separate';
COMMENT ON COLUMN rate_limits.operation_name IS 'NULL = applies to all operations for this provider';
COMMENT ON COLUMN rate_limits.window_type IS 'Lookup category: rate_limit_window (second, minute, hour, day)';
COMMENT ON COLUMN rate_limits.window_size IS 'How many units in window';
COMMENT ON COLUMN rate_limits.max_requests IS 'Quota per window';
COMMENT ON COLUMN rate_limits.backoff_strategy IS 'Lookup category: backoff_strategy (linear, exponential, fibonacci)';

-- =============================================================================
-- SECTION 5: provider_pricing (Plan.md Section 4.3, lines 864-884)
-- Dynamic cost per provider/operation
-- =============================================================================

CREATE TABLE provider_pricing (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT NOT NULL,
    unit_type TEXT NOT NULL,
    cost_per_unit_SAR DECIMAL(10, 4) NOT NULL,
    minimum_charge_SAR DECIMAL(10, 4) NOT NULL DEFAULT 0,
    free_tier_units INTEGER NOT NULL DEFAULT 0,
    effective_from DATE NOT NULL,
    effective_until DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name, effective_from)
);

CREATE INDEX idx_provider_pricing_provider_id ON provider_pricing(provider_id);
CREATE INDEX idx_provider_pricing_effective_from ON provider_pricing(effective_from);
CREATE INDEX idx_provider_pricing_provider_operation ON provider_pricing(provider_id, operation_name, effective_from);

COMMENT ON TABLE provider_pricing IS 'Dynamic pricing per provider/operation (updateable without code changes)';
COMMENT ON COLUMN provider_pricing.unit_type IS 'sms_segment, call_minute, api_call, free';
COMMENT ON COLUMN provider_pricing.cost_per_unit_SAR IS 'Cost per unit in Saudi Riyals';
COMMENT ON COLUMN provider_pricing.free_tier_units IS 'Monthly free quota (e.g., 1000 free geocodes)';

-- =============================================================================
-- SECTION 6: provider_health_metrics (Plan.md Section 4.3, lines 1044-1058)
-- =============================================================================

CREATE TABLE provider_health_metrics (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id) ON DELETE CASCADE,
    operation_name TEXT NOT NULL,
    time_bucket TIMESTAMPTZ NOT NULL,
    success_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    total_latency_ms BIGINT NOT NULL DEFAULT 0,
    p50_latency_ms INTEGER,
    p95_latency_ms INTEGER,
    p99_latency_ms INTEGER,
    total_cost DECIMAL(10, 4) NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name, time_bucket)
);

CREATE INDEX idx_provider_health_metrics_provider_id ON provider_health_metrics(provider_id);
CREATE INDEX idx_provider_health_metrics_time_bucket ON provider_health_metrics(time_bucket);
CREATE INDEX idx_provider_health_metrics_provider_operation ON provider_health_metrics(provider_id, operation_name, time_bucket DESC);

COMMENT ON TABLE provider_health_metrics IS 'Hourly provider health metrics aggregation';
COMMENT ON COLUMN provider_health_metrics.time_bucket IS 'Hourly buckets for metrics aggregation';
COMMENT ON COLUMN provider_health_metrics.total_cost IS 'Total cost for this time bucket in SAR';

-- =============================================================================
-- SECTION 7: webhook_sources (Plan.md Section 4.4, lines 1250-1269)
-- =============================================================================

CREATE TABLE webhook_sources (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    source_identifier TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    provider_type TEXT NOT NULL,
    auth_token TEXT NOT NULL UNIQUE,
    mapping_config_id UUID NOT NULL REFERENCES mapping_configs(id),
    rate_limit_per_hour INTEGER NOT NULL DEFAULT 1000,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_sources_organization_id ON webhook_sources(organization_id);
CREATE INDEX idx_webhook_sources_source_identifier ON webhook_sources(source_identifier);
CREATE INDEX idx_webhook_sources_enabled ON webhook_sources(enabled) WHERE enabled = true;
CREATE INDEX idx_webhook_sources_provider_type ON webhook_sources(provider_type);

COMMENT ON TABLE webhook_sources IS 'CLIENT webhook sources (Shopify, WooCommerce, ERPs, SaaS platforms) - not provider callbacks';
COMMENT ON COLUMN webhook_sources.source_identifier IS 'Unique identifier (e.g., clientA, clientB, delivery_provider)';
COMMENT ON COLUMN webhook_sources.provider_type IS 'shopify, woocommerce, generic, custom_erp, delivery_provider';
COMMENT ON COLUMN webhook_sources.auth_token IS 'Encrypted Bearer token for authentication (all CLIENT webhooks use /webhook endpoint)';
COMMENT ON COLUMN webhook_sources.mapping_config_id IS 'How to parse this webhook (FK to mapping_configs)';

-- =============================================================================
-- SECTION 8: webhook_inbox (Plan.md Section 4.4, lines 1271-1295)
-- =============================================================================

CREATE TABLE webhook_inbox (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_source_id UUID NOT NULL REFERENCES webhook_sources(id),
    provider_type TEXT NOT NULL,
    external_id TEXT,
    event_type TEXT,
    raw_payload JSONB NOT NULL,
    transformed_payload JSONB,
    headers JSONB,
    processing_status TEXT NOT NULL DEFAULT 'pending',
    correlation_id UUID NOT NULL, -- FK to request_contexts will be added in Migration 8
    lease_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    error_message TEXT,

    UNIQUE(webhook_source_id, external_id)
);

CREATE INDEX idx_webhook_inbox_source_id ON webhook_inbox(webhook_source_id);
CREATE INDEX idx_webhook_inbox_status ON webhook_inbox(processing_status, created_at) WHERE processing_status = 'pending';
CREATE INDEX idx_webhook_inbox_correlation_id ON webhook_inbox(correlation_id);
CREATE INDEX idx_webhook_inbox_provider_type ON webhook_inbox(provider_type);
CREATE INDEX idx_webhook_inbox_created_at ON webhook_inbox(created_at DESC);

COMMENT ON TABLE webhook_inbox IS 'Store all incoming webhooks for async processing';
COMMENT ON COLUMN webhook_inbox.processing_status IS 'Lookup category: processing_status (pending, processing, succeeded, failed)';
COMMENT ON COLUMN webhook_inbox.external_id IS 'Event ID from source (for deduplication) - UNIQUE per source';
COMMENT ON COLUMN webhook_inbox.event_type IS 'Extracted by orchestrator (e.g., shipment.created, status_update)';

-- =============================================================================
-- SECTION 9: webhook_rules (Plan.md Section 4.4, lines 1297-1315)
-- =============================================================================

CREATE TABLE webhook_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    webhook_source_id UUID NOT NULL REFERENCES webhook_sources(id),
    event_type TEXT NOT NULL,
    name TEXT NOT NULL,
    priority INTEGER NOT NULL DEFAULT 100,
    mapping_config_id UUID NOT NULL REFERENCES mapping_configs(id),
    workflow_template_id UUID,
    domain_category TEXT NOT NULL,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_webhook_rules_source_id ON webhook_rules(webhook_source_id);
CREATE INDEX idx_webhook_rules_event_type ON webhook_rules(event_type);
CREATE INDEX idx_webhook_rules_enabled ON webhook_rules(enabled) WHERE enabled = true;
CREATE INDEX idx_webhook_rules_priority ON webhook_rules(priority DESC);

COMMENT ON TABLE webhook_rules IS 'For each (source + event_type) reference canonical mapping and link to reusable workflow';
COMMENT ON COLUMN webhook_rules.event_type IS 'Event type identifier (e.g., shipment.created, status_update, tracking_event)';
COMMENT ON COLUMN webhook_rules.mapping_config_id IS 'Payload transformation + validation (FK to mapping_configs)';
COMMENT ON COLUMN webhook_rules.workflow_template_id IS 'Which orchestration pipeline to run next (FK to workflow_templates)';
COMMENT ON COLUMN webhook_rules.domain_category IS 'Lookup category: domain_category (shipment, tracking, communication, delivery_sync)';

-- =============================================================================
-- SECTION 10: circuit_breaker_state (Plan.md Section 4.3, lines 1020-1042)
-- =============================================================================

CREATE TABLE circuit_breaker_state (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider_id UUID NOT NULL REFERENCES providers(id),
    operation_name TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'closed',
    failure_count INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    last_failure_at TIMESTAMPTZ,
    last_success_at TIMESTAMPTZ,
    opened_at TIMESTAMPTZ,
    half_open_test_at TIMESTAMPTZ,
    reopen_count INTEGER NOT NULL DEFAULT 0,
    last_recovery_attempt_at TIMESTAMPTZ,
    manual_intervention_required BOOLEAN NOT NULL DEFAULT false,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(provider_id, operation_name)
);

CREATE INDEX idx_circuit_breaker_state_provider ON circuit_breaker_state(provider_id);
CREATE INDEX idx_circuit_breaker_state_half_open ON circuit_breaker_state(state, half_open_test_at) WHERE state = 'half_open';
CREATE INDEX idx_circuit_breaker_manual ON circuit_breaker_state(manual_intervention_required) WHERE manual_intervention_required = true;

COMMENT ON TABLE circuit_breaker_state IS 'Track circuit breaker state per provider operation';
COMMENT ON COLUMN circuit_breaker_state.state IS 'Lookup category: circuit_state (closed, open, half_open)';
COMMENT ON COLUMN circuit_breaker_state.half_open_test_at IS 'When circuit entered half_open (recovery testing)';
COMMENT ON COLUMN circuit_breaker_state.reopen_count IS 'How many times recovery failed and circuit reopened';
COMMENT ON COLUMN circuit_breaker_state.manual_intervention_required IS 'Set when max_reopen_count exceeded';

-- =============================================================================
-- Migration Complete - Phase 2 Rebuild
-- =============================================================================

-- This migration creates 10 tables following Plan.md 100%:
-- 1. providers (Plan.md Section 4.3, lines 759-771)
-- 2. provider_auth_configs (Plan.md Section 4.3, lines 773-790) - SIMPLIFIED
-- 3. operation_templates (Plan.md Section 4.3, lines 792-815)
-- 4. rate_limits (Plan.md Section 4.3, lines 845-862) - Technical rate limiting ONLY
-- 5. provider_pricing (Plan.md Section 4.3, lines 864-884) - Dynamic cost per provider/operation
-- 6. provider_health_metrics (Plan.md Section 4.3, lines 1044-1058)
-- 7. webhook_sources (Plan.md Section 4.4, lines 1250-1269)
-- 8. webhook_inbox (Plan.md Section 4.4, lines 1271-1295)
-- 9. webhook_rules (Plan.md Section 4.4, lines 1297-1315)
-- 10. circuit_breaker_state (Plan.md Section 4.3, lines 1020-1042)
--
-- Key Plan.md Compliance:
-- ✅ providers: ALL columns from Plan.md (lines 759-771)
-- ✅ provider_auth_configs: SIMPLIFIED version (lines 773-790) - removed refresh_token_config
-- ✅ operation_templates: REQUIRED mapping_config_id constraint (line 810)
-- ✅ rate_limits: Technical rate limiting ONLY, cost tracking separate (lines 845-862)
-- ✅ provider_pricing: Dynamic pricing with SAR currency (lines 864-884)
-- ✅ webhook_sources: CLIENT webhooks (NOT provider callbacks) (lines 1250-1269)
-- ✅ webhook_inbox: UNIQUE(webhook_source_id, external_id) deduplication (lines 1271-1295)
-- ✅ webhook_rules: Links to mapping_configs + workflow_templates (lines 1297-1315)
-- ✅ circuit_breaker_state: Recovery tracking fields (lines 1020-1042)
--
-- No partitioning in this migration (all tables non-partitioned)
--
-- Next migration (005) will create communications, budget, and workflow tables
