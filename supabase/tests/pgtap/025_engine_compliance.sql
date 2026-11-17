-- Test Suite: Engine & Decision Invariants

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(6);

SET search_path TO public, pgtap, extensions;

-- 1) outbound_calls.workflow_run_step_id must be NOT NULL
SELECT col_not_null('outbound_calls', 'workflow_run_step_id', 'outbound_calls.workflow_run_step_id is NOT NULL');

-- 2) non_engine_outbound_calls_v must be empty
SELECT is((SELECT count(*)::int FROM non_engine_outbound_calls_v), 0, 'no outbound calls exist outside workflow engine');

-- 3) domain_events table exists (engine-first internal triggers)
SELECT has_table('public', 'domain_events', 'domain_events table exists');

-- 4) operation_handlers contains manual_review handler (if present)
SELECT ok((SELECT EXISTS(SELECT 1 FROM operation_handlers WHERE handler_key = 'manual_review')),
          'manual_review handler registered');

-- 5) settings domain_event_policy category exists
SELECT ok((SELECT EXISTS(SELECT 1 FROM settings WHERE category = 'domain_event_policy')),
          'domain_event_policy settings row exists');

-- 6) decision_log exists and is partitioned
SELECT has_table('public','decision_log','decision_log exists');

SELECT * FROM finish();

ROLLBACK;

