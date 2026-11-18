-- Migration: bound per-row purge progress and diagnostics.
-- STATUS: NOT YET APPLIED IN PROD; apply via the next approved prod session.
-- Depends on 20261105000200_purge_log_retention_fk_progress_v1.sql.

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
  row_ref record;
  deleted_count bigint;
  row_deleted bigint;
  skipped_fk_count bigint;
  target_errors jsonb;
  out jsonb := '{}'::jsonb;
BEGIN
  IF p_batch IS NULL OR p_batch < 1 THEN
    RAISE EXCEPTION 'p_batch must be >= 1';
  END IF;
  FOR t IN SELECT * FROM jsonb_array_elements(p_targets) LOOP
    deleted_count := 0;
    skipped_fk_count := 0;
    target_errors := '[]'::jsonb;
    BEGIN
      EXECUTE format(
        'DELETE FROM %1$s WHERE (tableoid, ctid) IN (SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2)',
        (t->>'rel')::regclass, t->>'ts')
      USING t->>'keep', p_batch;
      GET DIAGNOSTICS deleted_count = ROW_COUNT;
    EXCEPTION
      WHEN foreign_key_violation THEN
        BEGIN
          FOR row_ref IN EXECUTE format(
            'SELECT tableoid, ctid FROM %1$s WHERE %2$I < now() - $1::interval LIMIT $2',
            (t->>'rel')::regclass, t->>'ts')
          USING t->>'keep', p_batch LOOP
            BEGIN
              EXECUTE format('DELETE FROM %1$s WHERE tableoid = $1 AND ctid = $2', (t->>'rel')::regclass)
              USING row_ref.tableoid, row_ref.ctid;
              GET DIAGNOSTICS row_deleted = ROW_COUNT;
              deleted_count := deleted_count + row_deleted;
            EXCEPTION
              WHEN foreign_key_violation THEN
                skipped_fk_count := skipped_fk_count + 1;
              WHEN OTHERS THEN
                target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
                EXIT;
            END;
          END LOOP;
        EXCEPTION
          WHEN OTHERS THEN
            target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
        END;
      WHEN OTHERS THEN
        target_errors := target_errors || jsonb_build_array(jsonb_build_object('sqlstate', SQLSTATE, 'message', SQLERRM));
    END;
    out := out || jsonb_build_object(
      t->>'rel',
      jsonb_build_object('deleted', deleted_count, 'skipped_fk', skipped_fk_count, 'errors', target_errors));
  END LOOP;
  RETURN out;
END;
$$;

REVOKE ALL ON FUNCTION public.purge_log_retention_v1(jsonb, integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.purge_log_retention_v1(jsonb, integer) TO service_role;

COMMENT ON FUNCTION public.purge_log_retention_v1(jsonb, integer) IS
  'Returns one object per target with deleted and skipped_fk counts plus an errors array of sqlstate/message objects; target failures do not abort other targets.';
