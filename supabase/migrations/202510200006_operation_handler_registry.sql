-- Migration: Operation handler registry
-- Purpose: Create canonical registry for workflow operation handlers with governance metadata.
-- Date: 2025-10-20

BEGIN;

CREATE TABLE IF NOT EXISTS operation_handlers (
    handler_key TEXT PRIMARY KEY,
    handler_schema TEXT NOT NULL,
    handler_name TEXT NOT NULL,
    handler_signature TEXT NOT NULL,
    handler_version TEXT NOT NULL DEFAULT 'v1',
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    created_by UUID REFERENCES users(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    notes TEXT,
    doc_url TEXT,
    CONSTRAINT operation_handlers_version_ck CHECK (handler_version ~ '^v[0-9]+$'),
    CONSTRAINT operation_handlers_unique_function UNIQUE (handler_schema, handler_name, handler_signature, handler_version)
);

COMMENT ON TABLE operation_handlers IS 'Registry of workflow operation handlers that the dispatcher can execute dynamically.';
COMMENT ON COLUMN operation_handlers.handler_key IS 'Stable identifier referenced by workflow templates and steps.';
COMMENT ON COLUMN operation_handlers.handler_schema IS 'Schema housing the handler function.';
COMMENT ON COLUMN operation_handlers.handler_name IS 'Function name implementing the handler.';
COMMENT ON COLUMN operation_handlers.handler_signature IS 'Handler function signature, stored for validation (e.g., (workflow_run_steps,workflow_runs,jsonb)).';
COMMENT ON COLUMN operation_handlers.handler_version IS 'Semantic version identifier (e.g., v1).';
COMMENT ON COLUMN operation_handlers.is_active IS 'Flag to disable a handler without deleting metadata.';
COMMENT ON COLUMN operation_handlers.created_by IS 'User or service account that registered the handler.';

CREATE INDEX IF NOT EXISTS idx_operation_handlers_is_active ON operation_handlers(is_active);

ALTER TABLE operation_handlers ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS operation_handlers_service_policy ON operation_handlers;
CREATE POLICY operation_handlers_service_policy ON operation_handlers
    FOR ALL
    TO service_role
    USING (TRUE)
    WITH CHECK (TRUE);

DROP POLICY IF EXISTS operation_handlers_read_policy ON operation_handlers;
CREATE POLICY operation_handlers_read_policy ON operation_handlers
    FOR SELECT
    TO authenticated
    USING (TRUE);

INSERT INTO operation_handlers (
    handler_key,
    handler_schema,
    handler_name,
    handler_signature,
    handler_version,
    is_active,
    created_by,
    notes,
    doc_url
)
VALUES
    (
        'outbound_http',
        'workflow_handlers',
        'execute_outbound_http_v1',
        '(workflow_run_steps,workflow_runs,jsonb)',
        'v1',
        TRUE,
        NULL,
        'Default outbound HTTP handler (inserts outbound_calls jobs with request mapping).',
        'docs/ops/runbooks/workflow_engine_runbook.md'
    ),
    (
        'label_job',
        'workflow_handlers',
        'execute_label_job_v1',
        '(workflow_run_steps,workflow_runs,jsonb)',
        'v1',
        TRUE,
        NULL,
        'Label generation handler for enqueue + wait actions.',
        'docs/ops/runbooks/label_renderer_runbook.md'
    ),
    (
        'workflow_control',
        'workflow_handlers',
        'execute_workflow_control_v1',
        '(workflow_run_steps,workflow_runs,jsonb)',
        'v1',
        TRUE,
        NULL,
        'Workflow control handler (e.g., mark workflow completed).',
        'docs/ops/runbooks/workflow_engine_runbook.md'
    )
ON CONFLICT (handler_key) DO UPDATE
SET
    handler_schema = EXCLUDED.handler_schema,
    handler_name = EXCLUDED.handler_name,
    handler_signature = EXCLUDED.handler_signature,
    handler_version = EXCLUDED.handler_version,
    is_active = EXCLUDED.is_active,
    notes = EXCLUDED.notes,
    doc_url = EXCLUDED.doc_url,
    updated_at = now();

COMMIT;
