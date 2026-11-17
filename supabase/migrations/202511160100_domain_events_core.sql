-- Migration: Domain events table and worker wiring
-- Purpose: Provide a universal engine-first entry point for internal triggers.
-- Notes:
--   * Introduces domain_events ledger with RLS and helper APIs.
--   * Seeds worker_registry/cron_config with domain_events_worker.

BEGIN;

-------------------------------------------------------------------------------
-- 1. Domain events table
-------------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS domain_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    organization_id UUID NOT NULL,
    event_type TEXT NOT NULL,
    resource_type TEXT,
    resource_id UUID,
    workflow_run_id UUID,
    correlation_id UUID,
    payload JSONB NOT NULL DEFAULT '{}'::jsonb,
    status TEXT NOT NULL DEFAULT 'pending',
    error_reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    processed_at TIMESTAMPTZ,
    CONSTRAINT domain_events_status_check CHECK (status IN ('pending', 'processing', 'completed', 'failed', 'skipped'))
);

COMMENT ON TABLE domain_events IS 'Ledger of internal triggers that always consult the workflow engine first.';
COMMENT ON COLUMN domain_events.event_type IS 'Logical event key (e.g. shipment_status_changed, address_updated, label_reprint_requested).';
COMMENT ON COLUMN domain_events.resource_type IS 'Resource impacted by this event (shipment, address, label_job, etc.).';
COMMENT ON COLUMN domain_events.workflow_run_id IS 'Workflow run created to process this domain event (NULL until dispatched).';
COMMENT ON COLUMN domain_events.status IS 'pending -> processing -> completed/failed/skipped (single source of truth).';

CREATE INDEX IF NOT EXISTS idx_domain_events_status_created
    ON domain_events(status, created_at);

CREATE INDEX IF NOT EXISTS idx_domain_events_org_status
    ON domain_events(organization_id, status);

CREATE INDEX IF NOT EXISTS idx_domain_events_workflow
    ON domain_events(workflow_run_id);

ALTER TABLE domain_events ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS domain_events_authenticated_select ON domain_events;
CREATE POLICY domain_events_authenticated_select ON domain_events
    FOR SELECT
    TO authenticated
    USING (organization_id = current_user_org_id());

DROP POLICY IF EXISTS domain_events_authenticated_insert ON domain_events;
CREATE POLICY domain_events_authenticated_insert ON domain_events
    FOR INSERT
    TO authenticated
    WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS domain_events_service_role_all ON domain_events;
CREATE POLICY domain_events_service_role_all ON domain_events
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

-------------------------------------------------------------------------------
-- 2. Helper to enqueue domain events (engine-first contract)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION enqueue_domain_event(
    p_organization_id UUID,
    p_event_type TEXT,
    p_resource_type TEXT DEFAULT NULL,
    p_resource_id UUID DEFAULT NULL,
    p_payload JSONB DEFAULT '{}'::jsonb,
    p_correlation_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_id UUID;
BEGIN
    IF p_organization_id IS NULL THEN
        RAISE EXCEPTION 'enqueue_domain_event requires organization_id';
    END IF;

    INSERT INTO domain_events (
        organization_id,
        event_type,
        resource_type,
        resource_id,
        payload,
        correlation_id,
        status
    ) VALUES (
        p_organization_id,
        lower(p_event_type),
        lower(p_resource_type),
        p_resource_id,
        COALESCE(p_payload, '{}'::jsonb),
        p_correlation_id,
        'pending'
    )
    RETURNING id INTO v_id;

    RETURN v_id;
END;
$$;

COMMENT ON FUNCTION enqueue_domain_event(UUID, TEXT, TEXT, UUID, JSONB, UUID)
    IS 'Insert a domain_events row (engine-first trigger). Returns domain_event.id.';

REVOKE ALL ON FUNCTION enqueue_domain_event(UUID, TEXT, TEXT, UUID, JSONB, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION enqueue_domain_event(UUID, TEXT, TEXT, UUID, JSONB, UUID) TO authenticated;
GRANT EXECUTE ON FUNCTION enqueue_domain_event(UUID, TEXT, TEXT, UUID, JSONB, UUID) TO service_role;

-------------------------------------------------------------------------------
-- 3. Resolve domain event policy from settings ladder
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION resolve_domain_event_policy(
    p_organization_id UUID,
    p_event_type TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_settings JSONB;
    v_policy JSONB;
BEGIN
    v_settings := resolve_settings('domain_event_policy', 'tenant', p_organization_id);

    IF v_settings IS NULL THEN
        RETURN NULL;
    END IF;

    IF v_settings ? 'events' THEN
        v_policy := v_settings->'events'->lower(p_event_type);
    ELSE
        v_policy := v_settings->lower(p_event_type);
    END IF;

    IF v_policy IS NULL OR jsonb_typeof(v_policy) <> 'object' THEN
        RETURN NULL;
    END IF;

    RETURN v_policy;
END;
$$;

COMMENT ON FUNCTION resolve_domain_event_policy(UUID, TEXT)
    IS 'Fetch per-event workflow policy from settings ladder; returns NULL when not configured.';

-------------------------------------------------------------------------------
-- 4. Domain events worker (dispatches workflows)
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION run_domain_events_worker()
RETURNS JSON
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_throttle RECORD;
    v_context UUID;
    v_processed INT := 0;
    v_error BOOLEAN := FALSE;
    v_event RECORD;
    v_policy JSONB;
    v_template UUID;
    v_context_patch JSONB;
    v_workflow_context JSONB;
    v_run UUID;
BEGIN
    SELECT * INTO v_throttle FROM check_throttle('domain_events_worker');
    IF NOT v_throttle.should_run THEN
        RETURN json_build_object('status', 'throttled', 'reason', v_throttle.reason);
    END IF;

    v_context := create_request_context('domain_events_worker');

    FOR v_event IN
        SELECT *
        FROM domain_events
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT v_throttle.batch_size
        FOR UPDATE SKIP LOCKED
    LOOP
        BEGIN
            v_policy := resolve_domain_event_policy(v_event.organization_id, v_event.event_type);
            v_template := NULLIF(v_policy->>'workflow_template_id', '')::UUID;
            v_context_patch := COALESCE(v_policy->'context_patch', '{}'::jsonb);

            IF v_template IS NULL THEN
                UPDATE domain_events
                SET status = 'skipped',
                    error_reason = 'policy_not_found',
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                PERFORM log_decision(
                    p_organization_id := v_event.organization_id,
                    p_decision_category := 'domain_event',
                    p_resource_type := 'domain_event',
                    p_resource_id := v_event.id,
                    p_decision_point := 'dispatch',
                    p_decision_outcome := 'skipped',
                    p_performed_by_system := 'domain_events_worker',
                    p_correlation_id := v_event.correlation_id,
                    p_decision_inputs := jsonb_build_object(
                        'event_type', v_event.event_type,
                        'resource_type', v_event.resource_type,
                        'resource_id', v_event.resource_id,
                        'reason', 'policy_not_found'
                    )
                );

                CONTINUE;
            END IF;

            v_workflow_context := jsonb_strip_nulls(
                jsonb_build_object(
                    'domain_event_id', v_event.id,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id,
                    'payload', v_event.payload,
                    'trigger_source', 'domain_event'
                )
            ) || jsonb_strip_nulls(COALESCE(v_context_patch, '{}'::jsonb));

            v_run := start_workflow_run(v_template, v_workflow_context);

            UPDATE domain_events
            SET status = 'processing',
                workflow_run_id = v_run,
                processed_at = now(),
                updated_at = now()
            WHERE id = v_event.id;

            PERFORM log_decision(
                p_organization_id := v_event.organization_id,
                p_decision_category := 'domain_event',
                p_resource_type := 'domain_event',
                p_resource_id := v_event.id,
                p_decision_point := 'dispatch',
                p_decision_outcome := 'enqueued',
                p_performed_by_system := 'domain_events_worker',
                p_correlation_id := v_event.correlation_id,
                p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
                    'workflow_run_id', v_run,
                    'workflow_template_id', v_template,
                    'event_type', v_event.event_type,
                    'resource_type', v_event.resource_type,
                    'resource_id', v_event.resource_id
                ))
            );

            v_processed := v_processed + 1;
        EXCEPTION
            WHEN OTHERS THEN
                v_error := TRUE;
                UPDATE domain_events
                SET status = 'failed',
                    error_reason = SQLERRM,
                    processed_at = now(),
                    updated_at = now()
                WHERE id = v_event.id;

                PERFORM log_decision(
                    p_organization_id := v_event.organization_id,
                    p_decision_category := 'domain_event',
                    p_resource_type := 'domain_event',
                    p_resource_id := v_event.id,
                    p_decision_point := 'dispatch',
                    p_decision_outcome := 'error',
                    p_performed_by_system := 'domain_events_worker',
                    p_correlation_id := v_event.correlation_id,
                    p_decision_reason := SQLERRM,
                    p_decision_inputs := jsonb_build_object(
                        'event_type', v_event.event_type,
                        'resource_type', v_event.resource_type,
                        'resource_id', v_event.resource_id
                    )
                );
        END;
    END LOOP;

    PERFORM complete_request_context(v_context, v_error, v_processed);
    PERFORM update_cron_config('domain_events_worker');

    RETURN json_build_object(
        'status', 'completed',
        'items_processed', v_processed,
        'error_occurred', v_error
    );
END;
$$;

COMMENT ON FUNCTION run_domain_events_worker()
    IS 'Dispatch pending domain events by starting workflow runs per configured policy.';

-------------------------------------------------------------------------------
-- 5. Register domain_events_worker in worker_registry / cron_config
-------------------------------------------------------------------------------

INSERT INTO worker_registry (worker_name, worker_type, description, schedule, config, is_active)
VALUES (
    'domain_events_worker',
    'workflow',
    'Dispatches internal domain events into workflow engine based on policy settings.',
    '*/2 * * * *',
    '{
        "batch_size": 50,
        "timeout_seconds": 60,
        "retry_policy": {"max_retries": 5, "backoff": "exponential"}
    }'::jsonb,
    true
)
ON CONFLICT (worker_name) DO UPDATE
SET
    worker_type = EXCLUDED.worker_type,
    description = EXCLUDED.description,
    schedule = EXCLUDED.schedule,
    config = EXCLUDED.config,
    is_active = EXCLUDED.is_active,
    updated_at = now();

INSERT INTO cron_config (worker_name, interval_seconds, batch_size, enabled, notes)
VALUES (
    'domain_events_worker',
    120,
    50,
    true,
    'Throttle config for domain events worker (engine-first internal triggers).'
)
ON CONFLICT (worker_name) DO UPDATE
SET
    interval_seconds = EXCLUDED.interval_seconds,
    batch_size = EXCLUDED.batch_size,
    enabled = EXCLUDED.enabled,
    notes = EXCLUDED.notes;

-------------------------------------------------------------------------------
-- 6. Seed global domain_event_policy settings scaffold (no hardcoding later)
-------------------------------------------------------------------------------

WITH upsert_domain_event_settings AS (
    INSERT INTO settings_versions (id, category, scope_type, scope_id, scope_hash, version, value, schema_version, change_reason, approved_at, effective_from)
    VALUES (
        '99990000-0000-0000-0000-000000550001',
        'domain_event_policy',
        'global',
        NULL,
        '00000000-0000-0000-0000-000000000000',
        1,
        '{"events": {}}'::jsonb,
        1,
        'Seed global domain event policy (empty map, zero hardcoding).',
        workflow_now(),
        workflow_now()
    )
    ON CONFLICT (id, scope_hash) DO UPDATE
    SET value = EXCLUDED.value,
        change_reason = EXCLUDED.change_reason,
        approved_at = EXCLUDED.approved_at,
        effective_from = EXCLUDED.effective_from
    RETURNING id
)
INSERT INTO settings (id, category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated)
SELECT
    '99990000-0000-0000-0000-000000550100',
    'domain_event_policy',
    'global',
    NULL,
    '00000000-0000-0000-0000-000000000000',
    upsert_domain_event_settings.id,
    '{"events": {}}'::jsonb,
    workflow_now()
FROM upsert_domain_event_settings
ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = EXCLUDED.last_updated;

COMMIT;

