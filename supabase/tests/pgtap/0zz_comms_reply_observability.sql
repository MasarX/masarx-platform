-- Plan: PLAN-202511-comms-prod-ready / observability view coverage
-- Purpose: Ensure comms reply observability/failure views exist

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

SELECT has_view('public', 'comms_reply_events_v', 'comms_reply_events_v view exists');
SELECT has_view('public', 'comms_reply_failures_v', 'comms_reply_failures_v view exists');
SELECT has_view('public', 'comms_reply_latency_v', 'comms_reply_latency_v view exists');

SELECT * FROM finish();

ROLLBACK;
