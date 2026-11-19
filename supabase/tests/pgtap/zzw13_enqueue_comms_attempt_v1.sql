-- pgTAP: public.enqueue_comms_attempt_v1 contract — W13-5 OPERATIONS D3 §3.
-- Verifies:
--   1) Public RPC + api wrapper exist with correct signatures
--   2) Capability gate (comms.write) is enforced (function definition checks)
--   3) Policy gate keys are read from communication_policy
--   4) Role-baseline grants (anon revoked, authenticated/service_role granted)
--   5) Operator send insertion writes to public.outbound_calls canonical queue
SET search_path TO public, pgtap, extensions, pg_temp;

BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(10);

-- 1) Public RPC exists with the canonical signature
SELECT has_function(
  'public', 'enqueue_comms_attempt_v1', ARRAY['jsonb'],
  'public.enqueue_comms_attempt_v1(jsonb) exists'
);

-- 2) api wrapper exists with the canonical signature
SELECT has_function(
  'api', 'enqueue_comms_attempt_v1', ARRAY['jsonb'],
  'api.enqueue_comms_attempt_v1(jsonb) wrapper exists'
);

-- 3) The RPC body must reference the canonical communication_policy resolver
SELECT matches(
  pg_get_functiondef('public.enqueue_comms_attempt_v1(jsonb)'::regprocedure),
  'resolve_communication_policy',
  'enqueue_comms_attempt_v1 resolves communication_policy via canonical resolver'
);

-- 4) The RPC body must check the operator-initiated send policy gate
SELECT matches(
  pg_get_functiondef('public.enqueue_comms_attempt_v1(jsonb)'::regprocedure),
  'allow_operator_initiated_send',
  'enqueue_comms_attempt_v1 reads policy.allow_operator_initiated_send gate'
);

-- 5) The RPC must insert into the canonical outbound queue
SELECT matches(
  pg_get_functiondef('public.enqueue_comms_attempt_v1(jsonb)'::regprocedure),
  'INSERT INTO public.outbound_calls',
  'enqueue_comms_attempt_v1 inserts into public.outbound_calls canonical queue'
);

-- 6) The RPC must enforce the comms.write capability gate
SELECT matches(
  pg_get_functiondef('public.enqueue_comms_attempt_v1(jsonb)'::regprocedure),
  'user_has_resource_capability_v1',
  'enqueue_comms_attempt_v1 enforces capability gate via user_has_resource_capability_v1'
);

-- 7) anon must NOT be granted execute on the public RPC
SELECT ok(
  NOT has_function_privilege('anon', 'public.enqueue_comms_attempt_v1(jsonb)', 'EXECUTE'),
  'anon has no EXECUTE on public.enqueue_comms_attempt_v1(jsonb)'
);

-- 8) authenticated MUST have execute on the public RPC
SELECT ok(
  has_function_privilege('authenticated', 'public.enqueue_comms_attempt_v1(jsonb)', 'EXECUTE'),
  'authenticated has EXECUTE on public.enqueue_comms_attempt_v1(jsonb)'
);

-- 9) service_role MUST have execute on the public RPC
SELECT ok(
  has_function_privilege('service_role', 'public.enqueue_comms_attempt_v1(jsonb)', 'EXECUTE'),
  'service_role has EXECUTE on public.enqueue_comms_attempt_v1(jsonb)'
);

-- 10) anon must NOT be granted execute on the api wrapper
SELECT ok(
  NOT has_function_privilege('anon', 'api.enqueue_comms_attempt_v1(jsonb)', 'EXECUTE'),
  'anon has no EXECUTE on api.enqueue_comms_attempt_v1(jsonb)'
);

SELECT * FROM finish();
ROLLBACK;
