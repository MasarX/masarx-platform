-- pgTAP: shared identity, path, branch, dispute, and request-readback contracts.
BEGIN;
SET LOCAL search_path TO public, workflow_handlers, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(14);

SELECT ok(
  to_regprocedure('public.dispute_escalate_v1(jsonb)') IS NOT NULL
  AND to_regprocedure('api.dispute_escalate_v1(jsonb)') IS NOT NULL,
  'dispute escalation has public and browser-safe API entrypoints'
);
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.dispute_escalate_v1(jsonb)')) ~* 'v_correlation_id[[:space:]]+uuid[[:space:]]*:=[[:space:]]*gen_random_uuid[[:space:]]*[(][[:space:]]*[)]'
  AND pg_get_functiondef(to_regprocedure('public.dispute_escalate_v1(jsonb)')) ~ 'marketplace_disputes\.write'
  AND pg_get_functiondef(to_regprocedure('public.dispute_escalate_v1(jsonb)')) !~ '''disputes\.write''',
  'dispute escalation uses a valid UUID and the canonical capability'
);
SELECT ok(
  has_function_privilege('authenticated', 'api.dispute_escalate_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.dispute_escalate_v1(jsonb)', 'EXECUTE'),
  'dispute API wrapper is fail-closed'
);
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)'))
    ~ 'ON CONFLICT \(id\) DO NOTHING'
  AND pg_get_functiondef(to_regprocedure('public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)'))
    ~ 'FROM public\.users.*FOR UPDATE'
  AND pg_get_functiondef(to_regprocedure('public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)'))
    !~ 'ON CONFLICT \(id\) DO UPDATE',
  'tenant signup preserves and locks an existing user identity'
);
SELECT is(
  workflow_handlers.resolve_path_text('{"fallback":{"value":"array-ok"}}'::jsonb, '["$.missing","$.fallback.value"]'),
  'array-ok',
  'path resolver accepts ordered JSON string arrays'
);
SELECT is(
  workflow_handlers.resolve_path_text('{"fallback":{"value":"pipe-ok"}}'::jsonb, '$.missing|fallback.value'),
  'pipe-ok',
  'path resolver preserves scalar and pipe fallback behavior'
);
SELECT throws_ok(
  $$SELECT workflow_handlers.resolve_path_text('{"value":"no"}'::jsonb, '["$.value",7]')$$,
  '22023',
  'resolve_path_text requires a JSON string array',
  'path resolver rejects malformed JSON arrays'
);
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.branch_zone_assign_v1(jsonb)')) ~ 'agreements\.write'
  AND pg_get_functiondef(to_regprocedure('public.branch_zone_assign_v1(jsonb)')) !~ 'branches\.write'
  AND position('assert_capability_v1(''agreements.write'')' IN pg_get_functiondef(to_regprocedure('public.branch_zone_assign_v1(jsonb)')))
      < position('FROM public.branches' IN pg_get_functiondef(to_regprocedure('public.branch_zone_assign_v1(jsonb)'))),
  'branch-zone assignment authorizes before lookup with the canonical capability'
);
SELECT ok(
  position('assert_capability_v1(''agreements.write'')' IN pg_get_functiondef(to_regprocedure('public.branch_zone_unassign_v1(jsonb)')))
  < position('FROM public.branch_zones' IN pg_get_functiondef(to_regprocedure('public.branch_zone_unassign_v1(jsonb)'))),
  'branch-zone unassignment authorizes before row discovery'
);
SELECT ok(
  pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) ~ 'agreements\.write'
  AND pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')) !~ 'branches\.write'
  AND position('assert_capability_v1(''agreements.write'')' IN pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)')))
      < position('FROM public.branches' IN pg_get_functiondef(to_regprocedure('public.add_branch_member_v1(jsonb)'))),
  'branch membership authorizes before lookup with the canonical capability'
);
SELECT ok(
  to_regprocedure('api.branch_zone_assign_v1(jsonb)') IS NOT NULL
  AND to_regprocedure('api.branch_zone_unassign_v1(jsonb)') IS NOT NULL
  AND to_regprocedure('api.add_branch_member_v1(jsonb)') IS NOT NULL
  AND NOT has_function_privilege('anon', 'api.branch_zone_assign_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.branch_zone_unassign_v1(jsonb)', 'EXECUTE')
  AND NOT has_function_privilege('anon', 'api.add_branch_member_v1(jsonb)', 'EXECUTE'),
  'branch commands have fail-closed API wrappers'
);
SELECT is(
  (SELECT reloptions::text FROM pg_class WHERE oid = 'public.v_api_gateway_request_directory'::regclass),
  '{security_invoker=true}',
  'request directory remains security-invoker'
);
SELECT ok(
  pg_get_viewdef('public.v_api_gateway_request_directory'::regclass, TRUE)
    ~ 'ORDER BY[[:space:][:print:]]*address_update[[:space:][:print:]]*status_change[[:space:][:print:]]*THEN 0[[:space:][:print:]]*api_gateway_materialized[[:space:][:print:]]*THEN 1',
  'specific mutation actions outrank generic materialization'
);

SELECT is(
  (
    SELECT count(*)::INT
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'decision_category'
      AND lv.value = ANY (
        ARRAY[
          'dispute.escalate',
          'branches.zone_assign',
          'branches.zone_unassign',
          'branches.member_add'
        ]::TEXT[]
      )
      AND lv.status = 'active'
      AND lv.retired_at IS NULL
      AND lv.effective_from IS NULL
      AND lv.effective_until IS NULL
  ),
  4,
  'identity repair decision categories are active and unbounded'
);

SELECT * FROM finish();
ROLLBACK;
