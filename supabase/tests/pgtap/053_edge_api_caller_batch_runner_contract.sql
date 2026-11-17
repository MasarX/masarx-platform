-- Plan: PLAN-202601-logestechs-outbound-http2-fix / Step: S95
-- Purpose: Contract checks for edge api-caller autonomous execution primitives.

BEGIN;

SELECT plan(3);

SELECT ok(
  to_regprocedure('public.run_api_caller_batch(int)') IS NOT NULL,
  'run_api_caller_batch(int) exists'
);

SELECT ok(
  to_regprocedure('public.run_edge_api_caller_worker()') IS NOT NULL,
  'run_edge_api_caller_worker() exists'
);

SELECT ok(
  to_regprocedure('public.claim_pending_jobs(int)') IS NOT NULL,
  'claim_pending_jobs(int) exists'
);

SELECT * FROM finish();

ROLLBACK;
