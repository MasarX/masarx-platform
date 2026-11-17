-- Migration 5: Communications, Budget, and Workflow Tables
-- Purpose: Create 8 tables for messaging, pricing, budgets, and workflows with HASH + RANGE partitioning
-- Task: 3.4 - Create Migration 5: Communications
-- Dependencies: Migration 4 (webhook integration)
-- Follows: docs/product/standards/backend/migrations.md (small, focused changes, zero-hardcoding)
-- Follows: docs/product/standards/backend/models.md (timestamps, data integrity, appropriate data types)

-- =============================================================================
-- SECTION 1: Message Templates (Multi-channel message templates)
-- =============================================================================

CREATE TABLE message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id),
    template_name TEXT NOT NULL,
    channel TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'ar-SA',
    subject TEXT,
    body_template TEXT NOT NULL,
    variables JSONB,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, template_name, channel, locale),
    CONSTRAINT message_templates_channel_check CHECK (channel IN ('sms', 'email', 'whatsapp', 'push'))
);

CREATE INDEX idx_message_templates_client_id ON message_templates(client_id);
CREATE INDEX idx_message_templates_channel ON message_templates(channel);
CREATE INDEX idx_message_templates_is_active ON message_templates(is_active) WHERE is_active = true;

COMMENT ON TABLE message_templates IS 'Multi-channel message templates with variable substitution';
COMMENT ON COLUMN message_templates.body_template IS 'Template with {variable} placeholders for substitution';
COMMENT ON COLUMN message_templates.variables IS 'JSONB array of required variable names';

-- =============================================================================
-- SECTION 2: Pricing Rules (Dynamic pricing configuration)
-- =============================================================================

CREATE TABLE pricing_rules (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    rule_name TEXT NOT NULL,
    service_type service_type NOT NULL,
    channel TEXT NOT NULL,
    conditions JSONB,
    price_per_unit DECIMAL(10,4) NOT NULL,
    currency TEXT NOT NULL DEFAULT 'SAR',
    effective_from TIMESTAMPTZ NOT NULL DEFAULT now(),
    effective_until TIMESTAMPTZ,
    priority INTEGER NOT NULL DEFAULT 100,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT pricing_rules_price_check CHECK (price_per_unit >= 0),
    CONSTRAINT pricing_rules_effective_dates_check CHECK (effective_until IS NULL OR effective_until > effective_from),
    CONSTRAINT pricing_rules_priority_check CHECK (priority > 0),
    CONSTRAINT pricing_rules_channel_check CHECK (channel IN ('sms', 'email', 'whatsapp', 'push'))
);

CREATE INDEX idx_pricing_rules_client_id ON pricing_rules(client_id);
CREATE INDEX idx_pricing_rules_service_type ON pricing_rules(service_type);
CREATE INDEX idx_pricing_rules_channel ON pricing_rules(channel);
CREATE INDEX idx_pricing_rules_effective ON pricing_rules(effective_from, effective_until);
CREATE INDEX idx_pricing_rules_is_active ON pricing_rules(is_active) WHERE is_active = true;

COMMENT ON TABLE pricing_rules IS 'Dynamic pricing rules for communication channels';
COMMENT ON COLUMN pricing_rules.conditions IS 'JSONB conditions for when pricing applies (e.g., destination, volume)';
COMMENT ON COLUMN pricing_rules.priority IS 'Higher priority rules override lower ones';

-- =============================================================================
-- SECTION 3: Budget Pools (Communication budget tracking)
-- =============================================================================

CREATE TABLE budget_pools (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID NOT NULL REFERENCES clients(id),
    pool_name TEXT NOT NULL,
    budget_type TEXT NOT NULL,
    total_budget DECIMAL(12,2) NOT NULL,
    consumed_budget DECIMAL(12,2) NOT NULL DEFAULT 0.00,
    currency TEXT NOT NULL DEFAULT 'SAR',
    channel TEXT,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    auto_renew BOOLEAN NOT NULL DEFAULT false,
    alert_threshold_percent INTEGER NOT NULL DEFAULT 80,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, pool_name, period_start),
    CONSTRAINT budget_pools_budget_check CHECK (total_budget > 0),
    CONSTRAINT budget_pools_consumed_check CHECK (consumed_budget >= 0),
    CONSTRAINT budget_pools_period_check CHECK (period_end > period_start),
    CONSTRAINT budget_pools_alert_threshold_check CHECK (alert_threshold_percent BETWEEN 0 AND 100),
    CONSTRAINT budget_pools_budget_type_check CHECK (budget_type IN ('monthly', 'quarterly', 'annual', 'campaign')),
    CONSTRAINT budget_pools_channel_check CHECK (channel IS NULL OR channel IN ('sms', 'email', 'whatsapp', 'push'))
);

CREATE INDEX idx_budget_pools_client_id ON budget_pools(client_id);
CREATE INDEX idx_budget_pools_period ON budget_pools(period_start, period_end);
CREATE INDEX idx_budget_pools_is_active ON budget_pools(is_active) WHERE is_active = true;
CREATE INDEX idx_budget_pools_threshold ON budget_pools(client_id, consumed_budget, total_budget)
    WHERE is_active = true AND consumed_budget >= (total_budget * alert_threshold_percent / 100);

COMMENT ON TABLE budget_pools IS 'Communication budget tracking with threshold alerts';
COMMENT ON COLUMN budget_pools.alert_threshold_percent IS 'Trigger alert when consumed >= this percentage';
COMMENT ON COLUMN budget_pools.auto_renew IS 'Automatically create new pool when period ends';

-- =============================================================================
-- SECTION 4: Outbound Queue (Outbound message queue with HASH partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE outbound_queue (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL, -- Will reference shipments (Migration 6)
    client_id UUID NOT NULL REFERENCES clients(id),
    recipient_phone TEXT,
    recipient_email TEXT,
    channel TEXT NOT NULL,
    template_id UUID REFERENCES message_templates(id),
    message_body TEXT NOT NULL,
    variables JSONB,
    priority priority_level NOT NULL DEFAULT 'medium',
    status TEXT NOT NULL DEFAULT 'pending',
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    error_message TEXT,
    provider_id UUID REFERENCES providers(id),
    provider_message_id TEXT,
    cost DECIMAL(10,4),
    budget_pool_id UUID REFERENCES budget_pools(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, shipment_id),
    CONSTRAINT outbound_queue_channel_check CHECK (channel IN ('sms', 'email', 'whatsapp', 'push')),
    CONSTRAINT outbound_queue_status_check CHECK (status IN ('pending', 'processing', 'sent', 'delivered', 'failed', 'cancelled')),
    CONSTRAINT outbound_queue_recipient_check CHECK (
        (channel = 'sms' AND recipient_phone IS NOT NULL) OR
        (channel = 'email' AND recipient_email IS NOT NULL) OR
        (channel IN ('whatsapp', 'push'))
    )
) PARTITION BY HASH (shipment_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE outbound_queue_p0 PARTITION OF outbound_queue
    FOR VALUES WITH (MODULUS 1, REMAINDER 0);

CREATE INDEX idx_outbound_queue_p0_shipment_id ON outbound_queue_p0(shipment_id);
CREATE INDEX idx_outbound_queue_p0_client_id ON outbound_queue_p0(client_id);
CREATE INDEX idx_outbound_queue_p0_status ON outbound_queue_p0(status, scheduled_at);
CREATE INDEX idx_outbound_queue_p0_priority ON outbound_queue_p0(priority DESC, created_at);
CREATE INDEX idx_outbound_queue_p0_pending ON outbound_queue_p0(scheduled_at)
    WHERE status = 'pending';

COMMENT ON TABLE outbound_queue IS 'Outbound message queue with HASH partitioning by shipment_id';
COMMENT ON COLUMN outbound_queue.status IS 'pending = awaiting send, processing = in progress, sent = submitted to provider, delivered = confirmed delivery, failed = all retries exhausted';
COMMENT ON COLUMN outbound_queue.cost IS 'Cost charged for this message based on pricing rules';

-- =============================================================================
-- SECTION 5: Outbound History (Message delivery history with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE outbound_history (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    message_id UUID NOT NULL, -- References outbound_queue
    shipment_id UUID NOT NULL,
    client_id UUID NOT NULL REFERENCES clients(id),
    channel TEXT NOT NULL,
    recipient TEXT NOT NULL,
    message_body TEXT NOT NULL,
    status TEXT NOT NULL,
    sent_at TIMESTAMPTZ,
    delivered_at TIMESTAMPTZ,
    failed_at TIMESTAMPTZ,
    error_message TEXT,
    provider_id UUID REFERENCES providers(id),
    provider_message_id TEXT,
    provider_response JSONB,
    cost DECIMAL(10,4),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, message_id, created_at),
    CONSTRAINT outbound_history_channel_check CHECK (channel IN ('sms', 'email', 'whatsapp', 'push')),
    CONSTRAINT outbound_history_status_check CHECK (status IN ('sent', 'delivered', 'failed', 'bounced', 'undelivered'))
) PARTITION BY HASH (message_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE outbound_history_p0 PARTITION OF outbound_history
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partitions (monthly, current + 1 future month: October, November 2025)
CREATE TABLE outbound_history_2025_10 PARTITION OF outbound_history_p0
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

CREATE TABLE outbound_history_2025_11 PARTITION OF outbound_history_p0
    FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');

-- Indexes for partitions
CREATE INDEX idx_outbound_history_2025_10_shipment ON outbound_history_2025_10(shipment_id, created_at DESC);
CREATE INDEX idx_outbound_history_2025_10_client ON outbound_history_2025_10(client_id);
CREATE INDEX idx_outbound_history_2025_10_status ON outbound_history_2025_10(status);
CREATE INDEX idx_outbound_history_2025_10_channel ON outbound_history_2025_10(channel);

CREATE INDEX idx_outbound_history_2025_11_shipment ON outbound_history_2025_11(shipment_id, created_at DESC);

COMMENT ON TABLE outbound_history IS 'Immutable message delivery history with HASH + RANGE partitioning';
COMMENT ON COLUMN outbound_history.provider_response IS 'JSONB provider delivery status response';

-- =============================================================================
-- SECTION 6: Workflow Templates (Workflow definitions)
-- =============================================================================

CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    client_id UUID REFERENCES clients(id),
    template_name TEXT NOT NULL,
    description TEXT,
    trigger_event TEXT NOT NULL,
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(client_id, template_name)
);

CREATE INDEX idx_workflow_templates_client_id ON workflow_templates(client_id);
CREATE INDEX idx_workflow_templates_trigger_event ON workflow_templates(trigger_event);
CREATE INDEX idx_workflow_templates_is_active ON workflow_templates(is_active) WHERE is_active = true;

COMMENT ON TABLE workflow_templates IS 'Workflow template definitions for automated processes';
COMMENT ON COLUMN workflow_templates.trigger_event IS 'Event that triggers workflow (e.g., shipment_created, status_updated)';

-- =============================================================================
-- SECTION 7: Workflow Steps (Workflow step definitions)
-- =============================================================================

CREATE TABLE workflow_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
    step_name TEXT NOT NULL,
    step_type TEXT NOT NULL,
    step_order INTEGER NOT NULL,
    condition JSONB,
    action_config JSONB NOT NULL,
    retry_policy JSONB,
    timeout_seconds INTEGER NOT NULL DEFAULT 300,
    on_success_step_id UUID REFERENCES workflow_steps(id),
    on_failure_step_id UUID REFERENCES workflow_steps(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(workflow_template_id, step_order),
    CONSTRAINT workflow_steps_step_type_check CHECK (step_type IN ('send_message', 'call_webhook', 'update_status', 'wait', 'decision', 'geocode', 'route')),
    CONSTRAINT workflow_steps_timeout_check CHECK (timeout_seconds > 0)
);

CREATE INDEX idx_workflow_steps_template_id ON workflow_steps(workflow_template_id);
CREATE INDEX idx_workflow_steps_step_order ON workflow_steps(workflow_template_id, step_order);

COMMENT ON TABLE workflow_steps IS 'Individual steps within workflow templates';
COMMENT ON COLUMN workflow_steps.action_config IS 'JSONB configuration for step action';
COMMENT ON COLUMN workflow_steps.condition IS 'JSONB condition for conditional execution';

-- =============================================================================
-- SECTION 8: Workflow Execution Log (Workflow run history with HASH + RANGE partitioning)
-- =============================================================================

-- Create partitioned table
CREATE TABLE workflow_execution_log (
    id UUID NOT NULL DEFAULT gen_random_uuid(),
    shipment_id UUID NOT NULL,
    workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id),
    workflow_step_id UUID REFERENCES workflow_steps(id),
    execution_status TEXT NOT NULL,
    step_status TEXT NOT NULL,
    input_data JSONB,
    output_data JSONB,
    error_message TEXT,
    started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,
    duration_ms INTEGER,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    PRIMARY KEY (id, shipment_id, created_at),
    CONSTRAINT workflow_execution_log_execution_status_check CHECK (execution_status IN ('running', 'completed', 'failed', 'cancelled')),
    CONSTRAINT workflow_execution_log_step_status_check CHECK (step_status IN ('pending', 'running', 'success', 'failed', 'skipped'))
) PARTITION BY HASH (shipment_id);

-- Create HASH partition (MODULUS 1 for future expansion)
CREATE TABLE workflow_execution_log_p0 PARTITION OF workflow_execution_log
    FOR VALUES WITH (MODULUS 1, REMAINDER 0)
    PARTITION BY RANGE (created_at);

-- Create RANGE partition (monthly, current month October 2025)
CREATE TABLE workflow_execution_log_2025_10 PARTITION OF workflow_execution_log_p0
    FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');

-- Indexes for partition
CREATE INDEX idx_workflow_execution_log_2025_10_shipment ON workflow_execution_log_2025_10(shipment_id, created_at DESC);
CREATE INDEX idx_workflow_execution_log_2025_10_template ON workflow_execution_log_2025_10(workflow_template_id);
CREATE INDEX idx_workflow_execution_log_2025_10_status ON workflow_execution_log_2025_10(execution_status);

COMMENT ON TABLE workflow_execution_log IS 'Workflow execution history with HASH + RANGE partitioning';
COMMENT ON COLUMN workflow_execution_log.step_status IS 'Status of individual step execution';

-- =============================================================================
-- Migration Complete
-- =============================================================================

-- This migration creates 8 tables for communications, budget, and workflows:
-- 1. message_templates (non-partitioned)
-- 2. pricing_rules (non-partitioned)
-- 3. budget_pools (non-partitioned)
-- 4. outbound_queue (HASH partitioned by shipment_id)
-- 5. outbound_history (HASH partitioned by message_id, RANGE partitioned by created_at monthly)
-- 6. workflow_templates (non-partitioned)
-- 7. workflow_steps (non-partitioned)
-- 8. workflow_execution_log (HASH partitioned by shipment_id, RANGE partitioned by created_at monthly)
--
-- Partitioning Summary:
-- - 3 HASH partitions: outbound_queue_p0, outbound_history_p0, workflow_execution_log_p0
-- - 3 RANGE partitions:
--   * outbound_history_2025_10/11 (monthly)
--   * workflow_execution_log_2025_10 (monthly)
--
-- Total partitions created: 6 (3 HASH + 3 RANGE)
--
-- Zero-Hardcoding Compliance:
-- - Message templates drive all communications
-- - Pricing rules configurable per client
-- - Workflow templates enable zero-code automation
-- - No hardcoded messages or pricing
--
-- Next migration (006) will create domain tables with HASH partitioning

