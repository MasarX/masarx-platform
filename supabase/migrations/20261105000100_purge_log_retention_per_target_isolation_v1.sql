-- Migration: per-target isolation for the hourly log-retention purge.
-- STATUS: NOT YET APPLIED IN PROD; apply via the next approved prod session.
-- Depends on 20261104210000_audit_log_retention_purge_v1.sql and
-- 20261104211500_purge_request_contexts_7d.sql.
-- The prior migration's stale dependency reference is corrected here.

CREATE OR REPLACE FUNCTION public.purge_log_retention_v1(
  p_targets jsonb DEFAULT '[
    {"rel":"public.audit_table_changes","ts":"created_at","keep":"30 days"},
    {"rel":"cron.job_run_details","ts":"start_time","keep":"7 days"},
    {"rel":"net._http_response","ts":"created","keep":"1 day"},
    {"rel":"public.request_contexts","ts":"started_at","keep":"7 days"}
  ]'::jsonb,
  p_batch integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path TO pg_catalog, pg_temp
SET lock_timeout TO '5s'
AS $$
DECLARE
  t jsonb;
  n bigint;
  out jsonb := '{}'::jsonb;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'p_batch must be >= 1';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    BEGIN
      -- tableoid+ctid: ctid alone is not unique across partitions.
      -- shortcut: semi-join scans the target, fine at small steady-state sizes; switch to per-leaf/partition drop if a table grows to GBs again.
      EXECUTE format(
        'DELETE FROM %1$s WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2)',
        (t->>'rel')::regclass, t->>'ts')
      USING t->>'keep', p_batch;
      GET DIAGNOSTICS n = ROW_COUNT;
      out := out || jsonb_build_object(t->>'rel', n);
    EXCEPTION
      WHEN foreign_key_violation OR lock_not_available THEN
        out := out || jsonb_build_object(t->>'rel', SQLSTATE);
    END;
  END LOOP;
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_log_retention_v1(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_log_retention_v1(jsonb, integer) TO service_role;
