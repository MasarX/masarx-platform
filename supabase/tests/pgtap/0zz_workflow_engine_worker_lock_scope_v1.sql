BEGIN;

SELECT plan(21);

SELECT has_function(
  'public',
  'run_workflow_engine_worker',
  ARRAY[]::text[],
  'workflow engine compatibility worker exists'
);

SELECT has_function(
  'public',
  'run_workflow_engine_worker_once_v1',
  ARRAY['integer', 'uuid[]'],
  'single-run workflow worker helper exists'
);

SELECT has_function(
  'public',
  'run_workflow_engine_worker_step_v1',
  ARRAY['uuid', 'uuid[]'],
  'single-step workflow worker helper exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'run_workflow_engine_worker_batch_v1'
      AND p.prokind = 'p'
      AND p.pronargs = 0
  ),
  'top-level workflow batch procedure exists'
);

SELECT ok(
  NOT COALESCE((
    SELECT p.prosecdef
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'run_workflow_engine_worker_batch_v1'
      AND p.prokind = 'p'
      AND p.pronargs = 0
  ), true),
  'batch procedure is SECURITY INVOKER so transaction control remains valid'
);

SELECT ok(
  COALESCE((
    SELECT cardinality(p.proconfig)
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'run_workflow_engine_worker_batch_v1'
      AND p.prokind = 'p'
      AND p.pronargs = 0
  ), 0) = 0,
  'batch procedure has no SET clause that would prohibit transaction control'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_step_v1(uuid,uuid[])'::regprocedure),
  'ORDER BY[[:space:]]+CASE wr.workflow_status[[:space:][:print:]]+wr.updated_at ASC,[[:space:]]+wr.created_at ASC[[:space:]]+LIMIT 1[[:space:]]+FOR UPDATE SKIP LOCKED',
  'single-step helper preserves deterministic priority and locks only one candidate'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_step_v1(uuid,uuid[])'::regprocedure),
  'NOT \(wr\.id = ANY\(COALESCE\(p_excluded_run_ids, ARRAY\[\]::uuid\[\]\)\)\)',
  'single-step helper excludes runs already processed in the current batch'
);

SELECT is(
  (
    length(pg_get_functiondef('public.run_workflow_engine_worker_step_v1(uuid,uuid[])'::regprocedure))
    - length(replace(
        pg_get_functiondef('public.run_workflow_engine_worker_step_v1(uuid,uuid[])'::regprocedure),
        'public.progress_workflow_run(',
        ''
      ))
  ) / length('public.progress_workflow_run('),
  1,
  'single-step helper invokes canonical progression exactly once'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker()'::regprocedure),
  'run_workflow_engine_worker_once_v1\(v_max_steps\)',
  'compatibility worker delegates to exactly one compatibility helper invocation'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_once_v1(integer,uuid[])'::regprocedure),
  'run_workflow_engine_worker_step_v1\(NULL, p_excluded_run_ids\)',
  'compatibility helper delegates to exactly one single-step invocation'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_batch_v1()'::regprocedure),
  'FOR v_batch_index IN 1\.\.GREATEST\(COALESCE\(v_throttle\.batch_size, 1\), 1\) LOOP',
  'batch procedure preserves row-driven batch throughput'
);

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_batch_v1()'::regprocedure),
  'FOR v_step_index IN 1\.\.v_max_steps LOOP',
  'batch procedure preserves the row-driven per-run step budget'
);

SELECT ok(
  NOT has_function_privilege('service_role', 'public.run_workflow_engine_worker_once_v1(integer,uuid[])', 'EXECUTE'),
  'service role cannot bypass the top-level cron boundary through the internal helper'
);

SELECT ok(
  NOT has_function_privilege('service_role', 'public.run_workflow_engine_worker_step_v1(uuid,uuid[])', 'EXECUTE'),
  'service role cannot bypass the top-level cron boundary through the single-step helper'
);

SELECT ok(
  NOT has_function_privilege('service_role', 'public.run_workflow_engine_worker_batch_v1()', 'EXECUTE'),
  'service role cannot invoke the transaction-controlling batch procedure'
);

SELECT is(
  (
    SELECT j.username
    FROM cron.job j
    WHERE j.jobname = 'workflow_engine_tick'
    LIMIT 1
  ),
  (
    SELECT pg_get_userbyid(p.proowner)::text
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.proname = 'run_workflow_engine_worker_batch_v1'
      AND p.prokind = 'p'
      AND p.pronargs = 0
  ),
  'workflow cron identity owns the transaction-controlling procedure'
);

WITH worker AS (
  SELECT pg_get_functiondef(
    'public.run_workflow_engine_worker_batch_v1()'::regprocedure
  ) AS definition
),
positions AS (
  SELECT
    strpos(
      definition,
      'FOR v_batch_index IN 1..GREATEST(COALESCE(v_throttle.batch_size, 1), 1) LOOP'
    ) AS batch_loop_pos,
    strpos(definition, 'FOR v_step_index IN 1..v_max_steps LOOP') AS step_loop_pos,
    strpos(
      definition,
      'v_result := public.run_workflow_engine_worker_step_v1('
    ) AS step_call_pos,
    strpos(definition, 'COMMIT;') AS commit_pos
  FROM worker
)
SELECT ok(
  batch_loop_pos > 0
  AND step_loop_pos > batch_loop_pos
  AND step_call_pos > step_loop_pos
  AND commit_pos > step_call_pos,
  'batch procedure nests the step budget and commits after each single-step result'
)
FROM positions;

SELECT matches(
  pg_get_functiondef('public.run_workflow_engine_worker_batch_v1()'::regprocedure),
  'COMMIT;[[:space:]]+PERFORM set_config\(''request\.correlation_id'', v_context::text, true\);',
  'batch procedure restores transaction-local correlation context after each commit'
);

SELECT is(
  (
    SELECT command
    FROM cron.job
    WHERE jobname = 'workflow_engine_tick'
    LIMIT 1
  ),
  'CALL public.run_workflow_engine_worker_batch_v1();',
  'workflow cron uses a top-level CALL transaction boundary'
);

SELECT ok(
  position(
    'FOR UPDATE'
    IN upper(pg_get_functiondef('public.progress_workflow_run_base(uuid,jsonb)'::regprocedure))
  ) > 0,
  'canonical workflow progression retains exact per-run and step locking'
);

SELECT * FROM finish();

ROLLBACK;
