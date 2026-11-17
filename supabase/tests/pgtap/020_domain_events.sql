-- Plan: domain events plumbing
BEGIN;

SELECT plan(6);

SELECT has_table('public', 'domain_events', 'domain_events table exists');
SELECT has_function('public', 'enqueue_domain_event', ARRAY['uuid','text','text','uuid','jsonb','uuid'], 'enqueue_domain_event function exists');
SELECT has_function('public', 'run_domain_events_worker', ARRAY[]::text[], 'run_domain_events_worker function exists');
SELECT ok((SELECT EXISTS (
  SELECT 1 FROM information_schema.triggers
  WHERE event_object_schema = 'public'
    AND event_object_table = 'shipment_actions'
    AND trigger_name = 'trg_shipment_actions_domain_event'
)), 'shipment_actions trigger emits domain events');

SELECT ok((SELECT EXISTS (
  SELECT 1 FROM information_schema.triggers
  WHERE event_object_schema = 'public'
    AND event_object_table = 'addresses'
    AND trigger_name = 'trg_addresses_domain_event'
)), 'addresses trigger emits domain events');

SELECT has_trigger('public', 'workflow_runs', 'trg_workflow_runs_domain_event', 'workflow_runs completion trigger exists');

SELECT finish();

ROLLBACK;
