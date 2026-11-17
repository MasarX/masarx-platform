-- Test file: 0zz_log_retention_purge_v1.sql
-- Purpose: verify the production log-retention purge contract and audit suppression.

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(29);

SELECT has_function(
  'public',
  'purge_log_retention_v1',
  ARRAY['jsonb', 'integer'],
  'purge_log_retention_v1(jsonb, integer) exists'
);

SELECT ok(
  NOT has_function_privilege('anon', 'public.purge_log_retention_v1(jsonb,integer)', 'EXECUTE'),
  'anon cannot execute purge_log_retention_v1'
);
SELECT ok(
  NOT has_function_privilege('authenticated', 'public.purge_log_retention_v1(jsonb,integer)', 'EXECUTE'),
  'authenticated cannot execute purge_log_retention_v1'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    CROSS JOIN LATERAL aclexplode(p.proacl) acl
    WHERE n.nspname = 'public'
      AND p.proname = 'purge_log_retention_v1'
      AND acl.grantee = 0
      AND acl.privilege_type = 'EXECUTE'
  ),
  'PUBLIC cannot execute purge_log_retention_v1'
);
SELECT ok(
  has_function_privilege('service_role', 'public.purge_log_retention_v1(jsonb,integer)', 'EXECUTE'),
  'service_role can execute purge_log_retention_v1'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM cron.job
    WHERE jobname = 'log_retention_purge_hourly'
      AND schedule = '17 * * * *'
      AND command = 'SELECT public.purge_log_retention_v1()'
  ),
  'hourly log-retention cron job is scheduled at minute 17'
);

SELECT ok(
  (SELECT audit_enabled IS FALSE FROM public.table_contracts
   WHERE table_schema = 'public' AND table_name = 'cron_config'),
  'cron_config auditing is disabled'
);
SELECT ok(
  (SELECT audit_enabled IS FALSE FROM public.table_contracts
   WHERE table_schema = 'public' AND table_name = 'request_contexts'),
  'request_contexts auditing is disabled'
);
SELECT ok(
  (SELECT audit_enabled IS FALSE FROM public.table_contracts
   WHERE table_schema = 'public' AND table_name = 'worker_registry'),
  'worker_registry auditing is disabled'
);

SELECT is(
  (SELECT proconfig
   FROM pg_proc p
   JOIN pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'public' AND p.proname = 'purge_log_retention_v1'),
  ARRAY['search_path=pg_catalog, pg_temp', 'lock_timeout=5s']::text[],
  'purge function proconfig is exact'
);

SELECT is(
  ((regexp_match(
    (SELECT pg_get_expr(p.proargdefaults, p.oid)
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'purge_log_retention_v1'),
    $r$^'(.*)'::jsonb, 50000$r$
  ))[1])::jsonb,
  '[{"rel":"public.audit_table_changes","ts":"created_at","keep":"30 days"}, {"rel":"cron.job_run_details","ts":"start_time","keep":"7 days"}, {"rel":"net._http_response","ts":"created","keep":"1 day"}, {"rel":"public.request_contexts","ts":"started_at","keep":"7 days"}]'::jsonb,
  'purge function defaults are semantically exact'
);

CREATE TEMP TABLE purge_behavior (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
INSERT INTO purge_behavior VALUES
  (1, now() - interval '8 days'),
  (2, now() - interval '1 day');
CREATE TEMP TABLE purge_behavior_result AS
SELECT public.purge_log_retention_v1(
  '[{"rel":"pg_temp.purge_behavior","ts":"ts","keep":"7 days"}]'::jsonb
) AS value;
SELECT is((SELECT value->'pg_temp.purge_behavior'->>'deleted' FROM purge_behavior_result), '1', 'purge deletes one expired row');
SELECT is((SELECT count(*)::integer FROM purge_behavior WHERE ts < now() - interval '7 days'), 0, 'purge removes the old row');
SELECT is((SELECT count(*)::integer FROM purge_behavior WHERE ts >= now() - interval '7 days'), 1, 'purge keeps the recent row');

SELECT throws_ok(
  $$SELECT public.purge_log_retention_v1('[]'::jsonb, 0)$$,
  'P0001',
  'p_batch must be >= 1',
  'p_batch < 1 is rejected'
);

CREATE TEMP TABLE purge_batch (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
INSERT INTO purge_batch VALUES
  (1, now() - interval '8 days'),
  (2, now() - interval '8 days');
CREATE TEMP TABLE purge_batch_result AS
SELECT public.purge_log_retention_v1(
  '[{"rel":"pg_temp.purge_batch","ts":"ts","keep":"7 days"}]'::jsonb,
  1
) AS value;
SELECT is((SELECT value->'pg_temp.purge_batch'->>'deleted' FROM purge_batch_result), '1', 'p_batch limits one target run');
SELECT is((SELECT count(*)::integer FROM purge_batch), 1, 'p_batch leaves one expired row for the next run');

CREATE TEMP TABLE purge_parent (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
CREATE TEMP TABLE purge_child (
  parent_id integer NOT NULL REFERENCES purge_parent(id)
);
CREATE TEMP TABLE purge_other (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
INSERT INTO purge_parent VALUES
  (1, now() - interval '8 days'),
  (2, now() - interval '8 days');
INSERT INTO purge_child VALUES (1);
INSERT INTO purge_other VALUES (1, now() - interval '8 days');
CREATE TEMP TABLE purge_isolation_result AS
SELECT public.purge_log_retention_v1(
  '[{"rel":"pg_temp.purge_parent","ts":"ts","keep":"7 days"}, {"rel":"pg_temp.purge_other","ts":"ts","keep":"7 days"}]'::jsonb
) AS value;
SELECT is((SELECT value->'pg_temp.purge_parent'->>'skipped_fk' FROM purge_isolation_result), '1', 'foreign-key target records one skipped row and does not abort the run');
SELECT is((SELECT value->'pg_temp.purge_parent'->>'deleted' FROM purge_isolation_result), '1', 'foreign-key target still deletes unreferenced expired rows');
SELECT is((SELECT value->'pg_temp.purge_other'->>'deleted' FROM purge_isolation_result), '1', 'other targets still purge after a foreign-key failure');
SELECT is((SELECT count(*)::integer FROM purge_parent), 1, 'foreign-key protected row remains');
SELECT is((SELECT count(*)::integer FROM purge_other), 0, 'independent target row is deleted');

CREATE TEMP TABLE purge_bounded_parent (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
CREATE TEMP TABLE purge_bounded_child (
  parent_id integer NOT NULL REFERENCES purge_bounded_parent(id)
);
INSERT INTO purge_bounded_parent VALUES
  (1, now() - interval '8 days'),
  (2, now() - interval '8 days'),
  (3, now() - interval '8 days');
INSERT INTO purge_bounded_child VALUES (1), (2), (3);
CREATE TEMP TABLE purge_bounded_result AS
SELECT public.purge_log_retention_v1(
  '[{"rel":"pg_temp.purge_bounded_parent","ts":"ts","keep":"7 days"}]'::jsonb,
  2
) AS value;
SELECT is((SELECT value->'pg_temp.purge_bounded_parent'->>'skipped_fk' FROM purge_bounded_result), '2', 'foreign-key fallback visits at most p_batch protected rows');
SELECT is((SELECT value->'pg_temp.purge_bounded_parent'->>'deleted' FROM purge_bounded_result), '0', 'fully referenced batch makes no deletion progress');
SELECT is((SELECT value->'pg_temp.purge_bounded_parent'->'errors' FROM purge_bounded_result), '[]'::jsonb, 'typed fallback row identifiers produce no diagnostic errors');
SELECT is((SELECT count(*)::integer FROM purge_bounded_parent), 3, 'bounded fallback preserves every protected row');
SELECT is(
  public.purge_log_retention_v1('[{"rel":"pg_temp.purge_other","ts":"ts","keep":"7 days"}]'::jsonb, 2)
    ->'pg_temp.purge_other',
  '{"deleted":0,"skipped_fk":0,"errors":[]}'::jsonb,
  'empty target returns zero progress without accessing an unassigned row'
);

CREATE TEMP TABLE purge_after_missing (
  id integer PRIMARY KEY,
  ts timestamptz NOT NULL
);
INSERT INTO purge_after_missing VALUES (1, now() - interval '8 days');
CREATE TEMP TABLE purge_missing_result AS
SELECT public.purge_log_retention_v1(
  '[{"rel":"pg_temp.no_such_retention_table","ts":"ts","keep":"7 days"}, {"rel":"pg_temp.purge_after_missing","ts":"ts","keep":"7 days"}]'::jsonb
) AS value;
SELECT is((SELECT value->'pg_temp.no_such_retention_table'->'errors'->0->>'sqlstate' FROM purge_missing_result), '42P01', 'missing target is recorded as undefined_table');
SELECT is((SELECT value->'pg_temp.purge_after_missing'->>'deleted' FROM purge_missing_result), '1', 'target after missing relation still purges');

SELECT finish();

ROLLBACK;
