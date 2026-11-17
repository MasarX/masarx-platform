-- Test: create_request_context sets request.correlation_id for worker/cron writes

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(2);

-- Ensure we are not relying on request headers.
SELECT set_config('request.headers', '{}'::jsonb::text, true);
SELECT set_config('request.correlation_id', '', true);

DO $$
DECLARE
  v_corr UUID;
BEGIN
  v_corr := public.create_request_context('test_worker');

  PERFORM is(
    public.current_correlation_id(),
    v_corr,
    'create_request_context seeds request.correlation_id (current_correlation_id follows it)'
  );

  UPDATE public.partitioning_config
     SET partitions_ahead = partitions_ahead
   WHERE table_name = 'decision_log';

  PERFORM is(
    (SELECT correlation_id
       FROM public.audit_table_changes
      WHERE table_name = 'partitioning_config'
      ORDER BY created_at DESC
      LIMIT 1),
    v_corr,
    'audit_table_changes uses request.correlation_id from create_request_context'
  );
END $$;

SELECT finish();

ROLLBACK;

