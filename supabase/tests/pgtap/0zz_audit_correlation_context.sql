-- Test: Audit correlation_id resolves from request headers

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(3);

-- Ensure we test the header fallback path (not explicit request.correlation_id)
SELECT set_config('request.correlation_id', '', true);

DO $$
DECLARE
  v_corr UUID := gen_random_uuid();
BEGIN
  PERFORM set_config('request.headers', jsonb_build_object('x-correlation-id', v_corr::text)::text, true);

  PERFORM is(public.current_correlation_id(), v_corr, 'current_correlation_id() uses x-correlation-id header when request.correlation_id is unset');

  UPDATE public.partitioning_config
     SET partitions_ahead = partitions_ahead
   WHERE table_name = 'decision_log';

  PERFORM ok(
    (SELECT COUNT(*) FROM public.audit_table_changes WHERE table_name = 'partitioning_config') >= 1,
    'audit_table_changes captured partitioning_config update'
  );

  PERFORM is(
    (SELECT correlation_id
       FROM public.audit_table_changes
      WHERE table_name = 'partitioning_config'
      ORDER BY created_at DESC
      LIMIT 1),
    v_corr,
    'audit_table_changes correlation_id derives from request headers'
  );
END $$;

SELECT finish();

ROLLBACK;

