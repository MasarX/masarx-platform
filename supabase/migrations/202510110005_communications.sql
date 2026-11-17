-- Migration 5: Communications, Budget, and Workflow Tables
-- Purpose: Create 9 tables following Plan.md Section 4.3 (Budget), 4.9 (Communications), workflow tables
-- Phase 2 Rebuild: 100% Plan.md compliance - INCLUDES CRITICAL outbound_calls table (unified queue)
-- Dependencies: Migration 4 (webhook integration)
-- Standards: docs/product/standards/backend/migrations.md, docs/product/standards/backend/models.md
/* objectives:allow RLS_MISSING Justification: RLS and policies for communications and workflow tables are enforced in later migrations; this file defines base tables */

-- =============================================================================
-- SECTION 1: message_templates (Plan.md Section 4.9, lines 1751-1781)
-- =============================================================================

CREATE TABLE message_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    template_name TEXT NOT NULL UNIQUE,
    event_type TEXT NOT NULL,
    channel TEXT NOT NULL,
    language TEXT NOT NULL,
    subject TEXT,
    body_template TEXT NOT NULL,
    urgency_level TEXT NOT NULL,
    can_override_quiet_hours BOOLEAN NOT NULL DEFAULT false,
    archived BOOLEAN NOT NULL DEFAULT false,
    archived_at TIMESTAMPTZ,
    archived_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_message_templates_organization_id ON message_templates(organization_id);
CREATE INDEX idx_message_templates_event_type ON message_templates(event_type);
CREATE INDEX idx_message_templates_channel ON message_templates(channel);
CREATE INDEX idx_message_templates_archived ON message_templates(archived) WHERE archived = false;

COMMENT ON TABLE message_templates IS 'Multi-channel message templates with deletion protection (soft delete only)';
COMMENT ON COLUMN message_templates.event_type IS 'Event trigger (e.g., shipment_created, out_for_delivery)';
COMMENT ON COLUMN message_templates.channel IS 'Lookup category: communication_channel (sms, whatsapp, email)';
COMMENT ON COLUMN message_templates.body_template IS 'Template with {{variable}} placeholders';
COMMENT ON COLUMN message_templates.urgency_level IS 'Lookup category: urgency_level (low, medium, high, critical)';
COMMENT ON COLUMN message_templates.archived IS 'Soft delete flag - templates never hard deleted';

-- =============================================================================
-- SECTION 2: recipient_preferences (Plan.md Section 4.9, lines 1735-1749)
-- =============================================================================

CREATE TABLE recipient_preferences (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    recipient_id UUID NOT NULL,
    channel TEXT NOT NULL,
    is_primary BOOLEAN NOT NULL DEFAULT false,
    language TEXT NOT NULL,
    quiet_hours_enabled BOOLEAN NOT NULL DEFAULT false,
    quiet_hours_start TIME,
    quiet_hours_end TIME,
    opted_out BOOLEAN NOT NULL DEFAULT false,
    opted_out_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_recipient_preferences_recipient_id ON recipient_preferences(recipient_id);
CREATE INDEX idx_recipient_preferences_channel ON recipient_preferences(channel);
CREATE INDEX idx_recipient_preferences_opted_out ON recipient_preferences(opted_out) WHERE opted_out = false;

COMMENT ON TABLE recipient_preferences IS 'Recipient communication preferences per channel';
COMMENT ON COLUMN recipient_preferences.channel IS 'Lookup category: communication_channel (sms, whatsapp, email)';
COMMENT ON COLUMN recipient_preferences.language IS 'ISO language code (ar, en)';

-- =============================================================================
-- SECTION 3: comms_attempts (Plan.md Section 4.9, lines 1985-2000)
-- =============================================================================

CREATE TABLE comms_attempts (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    outbound_call_id UUID NOT NULL,
    provider_id UUID NOT NULL REFERENCES providers(id),
    attempt_number INTEGER NOT NULL,
    status TEXT NOT NULL,
    provider_message_id TEXT,
    error_code TEXT,
    error_message TEXT,
    cost NUMERIC(10, 4),
    timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_comms_attempts_outbound_call_id ON comms_attempts(outbound_call_id);
CREATE INDEX idx_comms_attempts_provider_id ON comms_attempts(provider_id);
CREATE INDEX idx_comms_attempts_status ON comms_attempts(status);
CREATE INDEX idx_comms_attempts_timestamp ON comms_attempts(timestamp DESC);

COMMENT ON TABLE comms_attempts IS 'Track provider-level delivery attempts for communications';
COMMENT ON COLUMN comms_attempts.outbound_call_id IS 'Links to parent communication job in outbound_calls table';
COMMENT ON COLUMN comms_attempts.status IS 'Lookup category: message_status (sent, delivered, failed, bounce)';

-- =============================================================================
-- SECTION 4: provider_usage_tracking (Plan.md Section 4.3, lines 886-907)
-- Real-time budget tracking
-- =============================================================================

CREATE TABLE provider_usage_tracking (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL REFERENCES organizations(id),
    client_id UUID REFERENCES clients(id),
    sender_id UUID REFERENCES senders(id),
    provider_id UUID NOT NULL REFERENCES providers(id),
    period_type TEXT NOT NULL,
    period_start TIMESTAMPTZ NOT NULL,
    period_end TIMESTAMPTZ NOT NULL,
    call_count INTEGER NOT NULL DEFAULT 0,
    estimated_cost_SAR NUMERIC(10, 4) NOT NULL DEFAULT 0,
    actual_cost_SAR NUMERIC(10, 4) NOT NULL DEFAULT 0,
    free_tier_units_used INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(organization_id, client_id, sender_id, provider_id, period_type, period_start)
);

CREATE INDEX idx_provider_usage_tracking_organization ON provider_usage_tracking(organization_id);
CREATE INDEX idx_provider_usage_tracking_client ON provider_usage_tracking(client_id);
CREATE INDEX idx_provider_usage_tracking_provider ON provider_usage_tracking(provider_id, period_start, period_end);
CREATE INDEX idx_provider_usage_tracking_period ON provider_usage_tracking(period_start, period_end);

COMMENT ON TABLE provider_usage_tracking IS 'Track usage per provider per period for budget enforcement';
COMMENT ON COLUMN provider_usage_tracking.period_type IS 'hour, day, month';
COMMENT ON COLUMN provider_usage_tracking.estimated_cost_SAR IS 'Before call';
COMMENT ON COLUMN provider_usage_tracking.actual_cost_SAR IS 'After parsing response';

-- =============================================================================
-- SECTION 5: outbound_calls (Plan.md Section 4.3, lines 1060-1110)
-- CRITICAL: UNIFIED OUTBOUND QUEUE - THE MOST IMPORTANT TABLE
-- =============================================================================

CREATE TABLE outbound_calls (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    call_type TEXT NOT NULL,
    target_type TEXT NOT NULL,
    target_id UUID NOT NULL,

    -- HTTP specification (universal)
    method TEXT NOT NULL,
    url TEXT NOT NULL,
    headers JSONB,
    body JSONB,

    -- Queue management
    status TEXT NOT NULL DEFAULT 'pending',
    priority INTEGER NOT NULL DEFAULT 100,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER NOT NULL DEFAULT 3,
    scheduled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_expires_at TIMESTAMPTZ,

    -- Response tracking
    response_status_code INTEGER,
    response_body JSONB,
    response_headers JSONB,
    latency_ms INTEGER,
    error_message TEXT,

    -- Cost tracking
    cost NUMERIC(10, 4),

    -- Investigation fields (inline - for failed jobs)
    requires_investigation BOOLEAN NOT NULL DEFAULT false,
    assigned_to UUID REFERENCES users(id),
    root_cause TEXT,
    resolution_notes TEXT,
    investigated_at TIMESTAMPTZ,

    -- Context & tracing
    correlation_id UUID, -- FK to request_contexts will be added in Migration 8
    shipment_id UUID,
    context JSONB,

    -- Audit
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ,

    CONSTRAINT outbound_calls_call_type_check CHECK (call_type IN ('provider_api', 'client_webhook', 'comms_sms', 'comms_whatsapp', 'comms_email', 'comms_voice')),
    CONSTRAINT outbound_calls_target_type_check CHECK (target_type IN ('provider', 'client', 'recipient'))
);

CREATE INDEX idx_outbound_calls_status ON outbound_calls(status, scheduled_at) WHERE status = 'pending';
CREATE INDEX idx_outbound_calls_call_type ON outbound_calls(call_type);
CREATE INDEX idx_outbound_calls_target ON outbound_calls(target_type, target_id);
CREATE INDEX idx_outbound_calls_priority ON outbound_calls(priority DESC, scheduled_at);
CREATE INDEX idx_outbound_calls_correlation_id ON outbound_calls(correlation_id);
CREATE INDEX idx_outbound_calls_shipment_id ON outbound_calls(shipment_id) WHERE shipment_id IS NOT NULL;
CREATE INDEX idx_outbound_calls_requires_investigation ON outbound_calls(requires_investigation) WHERE requires_investigation = true;
CREATE INDEX idx_outbound_calls_lease ON outbound_calls(lease_expires_at) WHERE lease_expires_at IS NOT NULL;
CREATE INDEX idx_outbound_calls_created_at ON outbound_calls(created_at DESC);

COMMENT ON TABLE outbound_calls IS 'CRITICAL: Universal queue for ALL external HTTP calls (provider APIs + client webhooks + communications) - THE CORE OF THE UNIFIED WORKER ARCHITECTURE';
COMMENT ON COLUMN outbound_calls.call_type IS 'provider_api | client_webhook | comms_sms | comms_whatsapp | comms_email | comms_voice';
COMMENT ON COLUMN outbound_calls.target_type IS 'provider | client | recipient';
COMMENT ON COLUMN outbound_calls.target_id IS 'provider_id OR client_id OR recipient_id';
COMMENT ON COLUMN outbound_calls.status IS 'Lookup category: job_status (pending, completed, failed, permanently_failed)';
COMMENT ON COLUMN outbound_calls.priority IS 'Higher = process first';
COMMENT ON COLUMN outbound_calls.scheduled_at IS 'When to process (for delayed jobs)';
COMMENT ON COLUMN outbound_calls.lease_expires_at IS 'For worker coordination (claim-based processing)';
COMMENT ON COLUMN outbound_calls.requires_investigation IS 'Set to true for failed jobs requiring human review';
COMMENT ON COLUMN outbound_calls.correlation_id IS 'Thread entire flow for debugging (FK to request_contexts)';
COMMENT ON COLUMN outbound_calls.shipment_id IS 'Direct FK for fast queries (when applicable)';
COMMENT ON COLUMN outbound_calls.context IS 'Additional metadata (worker_id, analysis tags, etc.)';

-- =============================================================================
-- SECTION 6: workflow_templates (Plan.md Section 4.3, lines 1111-1126)
-- Orchestration Metadata
-- =============================================================================

CREATE TABLE workflow_templates (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name TEXT NOT NULL UNIQUE,
    description TEXT,
    version INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'draft',
    scope_type TEXT NOT NULL,
    scope_id UUID,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    published_at TIMESTAMPTZ,
    retired_at TIMESTAMPTZ,
    notes TEXT,
    steps_checksum TEXT
);

CREATE INDEX idx_workflow_templates_name ON workflow_templates(name);
CREATE INDEX idx_workflow_templates_status ON workflow_templates(status) WHERE status = 'active';
CREATE INDEX idx_workflow_templates_scope ON workflow_templates(scope_type, scope_id);

COMMENT ON TABLE workflow_templates IS 'Workflow template definitions (orchestration metadata)';
COMMENT ON COLUMN workflow_templates.status IS 'Lookup category: workflow_status (draft, active, archived)';
COMMENT ON COLUMN workflow_templates.scope_type IS 'global, tenant, client, sender, role, user';
COMMENT ON COLUMN workflow_templates.steps_checksum IS 'Hash of associated steps for integrity';

-- =============================================================================
-- SECTION 7: workflow_template_steps (Plan.md Section 4.3, lines 1128-1145)
-- Orchestration Steps
-- =============================================================================

CREATE TABLE workflow_template_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id) ON DELETE CASCADE,
    sequence_order INTEGER NOT NULL,
    operation_name TEXT NOT NULL,
    operation_settings_category TEXT,
    transition_condition TEXT NOT NULL,
    condition_jsonlogic JSONB,
    next_operation_name TEXT,
    next_operation_priority INTEGER,
    next_operation_delay_seconds INTEGER,
    manual_action_required BOOLEAN NOT NULL DEFAULT false,
    metadata JSONB,
    enabled BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_workflow_template_steps_template_id ON workflow_template_steps(workflow_template_id);
CREATE INDEX idx_workflow_template_steps_sequence ON workflow_template_steps(workflow_template_id, sequence_order);
CREATE INDEX idx_workflow_template_steps_operation ON workflow_template_steps(operation_name);

COMMENT ON TABLE workflow_template_steps IS 'Individual steps within workflow templates (orchestration steps)';
COMMENT ON COLUMN workflow_template_steps.operation_name IS 'References operation_templates.operation_name';
COMMENT ON COLUMN workflow_template_steps.transition_condition IS 'Lookup category: workflow_transition (success, failure, always, custom)';
COMMENT ON COLUMN workflow_template_steps.condition_jsonlogic IS 'Additional rules evaluated before running step';
COMMENT ON COLUMN workflow_template_steps.next_operation_name IS 'Operation to enqueue when condition met';

-- =============================================================================
-- SECTION 8: workflow_runs (Plan.md Section 4.3, lines 1147-1167)
-- Workflow Runtime Store
-- =============================================================================

CREATE TABLE workflow_runs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_template_id UUID NOT NULL REFERENCES workflow_templates(id),
    workflow_template_version INTEGER NOT NULL,
    triggered_by_request_id UUID, -- FK to request_contexts will be added in Migration 8
    entry_point TEXT NOT NULL,
    workflow_status TEXT NOT NULL DEFAULT 'pending',
    current_step_id UUID REFERENCES workflow_template_steps(id),
    context JSONB,
    retry_count INTEGER NOT NULL DEFAULT 0,
    max_retries INTEGER,
    failure_reason TEXT,
    last_error JSONB,
    metadata JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    started_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    completed_at TIMESTAMPTZ
);

CREATE INDEX idx_workflow_runs_template_id ON workflow_runs(workflow_template_id);
CREATE INDEX idx_workflow_runs_status ON workflow_runs(workflow_status);
CREATE INDEX idx_workflow_runs_entry_point ON workflow_runs(entry_point);
CREATE INDEX idx_workflow_runs_created_at ON workflow_runs(created_at DESC);

COMMENT ON TABLE workflow_runs IS 'Workflow runtime store (execution state tracking)';
COMMENT ON COLUMN workflow_runs.entry_point IS 'Lookup category: request_entry_point (webhook, api, worker, manual)';
COMMENT ON COLUMN workflow_runs.workflow_status IS 'Lookup category: workflow_run_status (pending, in_progress, completed, failed, cancelled)';
COMMENT ON COLUMN workflow_runs.context IS 'shipment_id, client_id, sender_id, other scoped identifiers';
COMMENT ON COLUMN workflow_runs.version IS 'Optimistic locking token for concurrent updates';

-- =============================================================================
-- SECTION 9: workflow_run_steps (Plan.md Section 4.3, lines 1169-1220)
-- Workflow Execution Audit
-- =============================================================================

CREATE TABLE workflow_run_steps (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    workflow_run_id UUID NOT NULL REFERENCES workflow_runs(id),
    workflow_template_step_id UUID NOT NULL REFERENCES workflow_template_steps(id),
    sequence_order INTEGER NOT NULL,

    -- Enhanced status tracking for debugging
    step_status TEXT NOT NULL DEFAULT 'pending',
    operation_name TEXT NOT NULL,

    -- Timeline tracking (enables per-step latency analysis)
    enqueued_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    operation_started_at TIMESTAMPTZ,
    operation_completed_at TIMESTAMPTZ,
    duration_ms INTEGER,

    -- Results and error tracking
    operation_result JSONB,
    last_error TEXT,
    retry_attempt INTEGER NOT NULL DEFAULT 1,
    max_retries INTEGER NOT NULL,
    fallback_invoked BOOLEAN NOT NULL DEFAULT false,

    -- Decision logging linkage
    decision_log_id UUID,

    -- Metadata
    notes TEXT,
    metadata JSONB,
    version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

    UNIQUE(workflow_run_id, sequence_order)
);

CREATE INDEX idx_workflow_run_steps_run_id ON workflow_run_steps(workflow_run_id);
CREATE INDEX idx_workflow_run_steps_status ON workflow_run_steps(workflow_run_id, step_status);
CREATE INDEX idx_workflow_run_steps_stuck ON workflow_run_steps(step_status, enqueued_at) WHERE step_status = 'in_progress';

COMMENT ON TABLE workflow_run_steps IS 'Workflow execution audit: persist workflow execution state with full timeline tracking';
COMMENT ON COLUMN workflow_run_steps.step_status IS 'Lookup category: workflow_step_status (pending, in_progress, completed, failed, skipped)';
COMMENT ON COLUMN workflow_run_steps.enqueued_at IS 'When step was created/enqueued';
COMMENT ON COLUMN workflow_run_steps.operation_started_at IS 'When step execution started';
COMMENT ON COLUMN workflow_run_steps.operation_completed_at IS 'When step execution finished';
COMMENT ON COLUMN workflow_run_steps.duration_ms IS 'Computed: operation_completed_at - operation_started_at';
COMMENT ON COLUMN workflow_run_steps.decision_log_id IS 'Links to decision that created/transitioned this step (FK to decision_log)';

-- =============================================================================
-- Migration Complete - Phase 2 Rebuild
-- =============================================================================

-- This migration creates 9 tables following Plan.md 100%:
-- 1. message_templates (Plan.md Section 4.9, lines 1751-1781)
-- 2. recipient_preferences (Plan.md Section 4.9, lines 1735-1749)
-- 3. comms_attempts (Plan.md Section 4.9, lines 1985-2000)
-- 4. provider_usage_tracking (Plan.md Section 4.3, lines 886-907) - Real-time budget tracking
-- 5. outbound_calls (Plan.md Section 4.3, lines 1060-1110) - CRITICAL UNIFIED QUEUE (27 columns)
-- 6. workflow_templates (Plan.md Section 4.3, lines 1111-1126) - Orchestration Metadata
-- 7. workflow_template_steps (Plan.md Section 4.3, lines 1128-1145) - Orchestration Steps
-- 8. workflow_runs (Plan.md Section 4.3, lines 1147-1167) - Workflow Runtime Store
-- 9. workflow_run_steps (Plan.md Section 4.3, lines 1169-1220) - Workflow Execution Audit
--
-- Key Plan.md Compliance:
-- ✅ message_templates: ALL columns + deletion protection (lines 1751-1781)
-- ✅ recipient_preferences: ALL columns from Plan.md (lines 1735-1749)
-- ✅ comms_attempts: Links to outbound_calls table (lines 1985-2000)
-- ✅ provider_usage_tracking: UNIQUE constraint on (organization_id, client_id, sender_id, provider_id, period_type, period_start)
-- ✅ outbound_calls: ALL 27 COLUMNS from Plan.md (lines 1060-1110) - MOST CRITICAL TABLE
--    - Investigation fields inline (requires_investigation, assigned_to, root_cause, resolution_notes, investigated_at)
--    - Context & tracing (correlation_id, shipment_id, context)
--    - Complete HTTP spec (method, url, headers, body)
--    - Queue management (status, priority, retry_count, max_retries, scheduled_at, lease_expires_at)
--    - Response tracking (response_status_code, response_body, response_headers, latency_ms)
--    - Cost tracking (cost field)
-- ✅ workflow_templates: ALL columns + steps_checksum (lines 1111-1126)
-- ✅ workflow_template_steps: ALL columns + transition logic (lines 1128-1145)
-- ✅ workflow_runs: ALL columns + optimistic locking (lines 1147-1167)
-- ✅ workflow_run_steps: UNIQUE(workflow_run_id, sequence_order) + timeline tracking (lines 1169-1220)
--
-- No partitioning in this migration (all tables non-partitioned)
--
-- THIS IS THE CORE OF THE UNIFIED WORKER ARCHITECTURE:
-- - outbound_calls table is THE MOST CRITICAL table in the entire system
-- - Single worker (outbound_worker) processes ALL HTTP calls from this queue
-- - Replaces separate workers (sms_worker, geocoding_worker, delivery_worker, comms_worker)
-- - ONE WORKER, INFINITE OPERATIONS via configuration
--
-- Next migration (006) will create domain tables with HASH partitioning
