-- Migration: audit noise suppression and hourly log retention purge
-- Applied in production on 2026-11-04; this append-only replay is idempotent.
-- Data TRUNCATE operations are intentionally excluded.

-- Migration: audit noise suppression + hourly log retention purge
-- Context: MasarX-PROD hit 9.6 GB (audit_table_changes ~9.1 GB, cron.job_run_details 0.8 GB) on Free plan.
--   Owner decision 2026-11-04: audit history not needed (no users, no real data). Applied live in r10 via SQL Editor.
-- 1) Stop auditing internal/noisy tables (row-driven via table_contracts; ensure_audit_triggers drops their triggers).
-- 2) One list-driven purge function + one hourly pg_cron job at :17.

UPDATE public.table_contracts
   SET audit_enabled = false,
       notes = concat_ws('; ', notes, '2026-11-04: audit disabled (internal/noisy churn)'),
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name IN ('cron_config', 'request_contexts', 'worker_registry')
   AND audit_enabled;

SELECT count(*) FROM public.ensure_audit_triggers();

-- p_targets: [{rel, ts, keep}] = relation, timestamp column, retention interval. Batch-bounded per table per run.
CREATE OR REPLACE FUNCTION public.purge_log_retention_v1(
  p_targets jsonb DEFAULT '[
    {"rel":"public.audit_table_changes","ts":"created_at","keep":"30 days"},
    {"rel":"cron.job_run_details","ts":"start_time","keep":"7 days"},
    {"rel":"net._http_response","ts":"created","keep":"1 day"}
  ]'::jsonb,
  p_batch integer DEFAULT 50000
)
RETURNS jsonb
LANGUAGE plpgsql
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
    -- tableoid+ctid: ctid alone is not unique across partitions.
    -- shortcut: semi-join scans the target, fine at small steady-state sizes; switch to per-leaf/partition drop if a table grows to GBs again.
    EXECUTE format(
      'DELETE FROM %1$s WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2)',
      (t->>'rel')::regclass, t->>'ts')
    USING t->>'keep', p_batch;
    GET DIAGNOSTICS n = ROW_COUNT;
    out := out || jsonb_build_object(t->>'rel', n);
  END LOOP;
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_log_retention_v1(jsonb, integer) FROM PUBLIC, anon, authenticated;

-- cron.schedule(name, ...) upserts by name: idempotent.
SELECT cron.schedule('log_retention_purge_hourly', '17 * * * *', 'SELECT public.purge_log_retention_v1()');
