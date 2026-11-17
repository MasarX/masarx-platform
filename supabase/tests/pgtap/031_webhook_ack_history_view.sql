-- Test Suite: webhook_ack_history compatibility view

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

SELECT ok(
  EXISTS (
    SELECT 1
      FROM information_schema.views
     WHERE table_schema = 'public'
       AND table_name = 'webhook_ack_history'
  ),
  'webhook_ack_history view exists'
);

SELECT has_column('public', 'webhook_ack_history', 'ack_body', 'webhook_ack_history has ack_body');
SELECT has_column('public', 'webhook_ack_history', 'ack_status_code', 'webhook_ack_history has ack_status_code');
SELECT has_column('public', 'webhook_ack_history', 'webhook_source_id', 'webhook_ack_history has webhook_source_id');
SELECT has_column('public', 'webhook_ack_history', 'ack_sent_at', 'webhook_ack_history has ack_sent_at');

SELECT * FROM finish();

ROLLBACK;
