-- Test Suite: Constraint hardening regression coverage

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SET search_path TO public, pgtap, extensions;

SELECT col_not_null('webhook_inbox', 'webhook_source_id', 'webhook_inbox.webhook_source_id is NOT NULL');
SELECT col_is_fk('webhook_inbox', 'webhook_source_id', 'webhook_sources', 'webhook_inbox webhooks reference sources');

SELECT col_is_fk('workflow_run_steps', 'workflow_run_id', 'workflow_runs', 'workflow_run_steps.workflow_run_id references workflow_runs');
SELECT col_is_fk('workflow_run_steps', 'workflow_template_step_id', 'workflow_template_steps', 'workflow_run_steps.workflow_template_step_id references workflow_template_steps');

SELECT col_is_fk('outbound_calls', 'workflow_run_step_id', 'workflow_run_steps', 'outbound_calls.workflow_run_step_id references workflow_run_steps');

SELECT * FROM finish();

ROLLBACK;
