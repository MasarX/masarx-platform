BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(4);

SELECT throws_ok(
  $$SELECT public.ui_assert_resource_read_scope_v1('{"read_scope_types":["client","client"]}', 'client', gen_random_uuid())$$,
  '23514', 'Duplicate resource read scopes', 'duplicate scope entries are rejected'
);
SELECT throws_ok(
  $$SELECT public.ui_assert_resource_read_scope_v1('{"read_scope_types":["client"]}', 'tenant', gen_random_uuid())$$,
  '42501', 'Resource read scope denied', 'a different scope cannot read an explicitly constrained resource'
);
SELECT throws_ok(
  $$SELECT public.ui_assert_resource_read_scope_v1('{"read_scope_types":["client"],"scope_columns":{"client":"client_id"}}', 'client', NULL)$$,
  '42501', 'Resource read scope binding missing', 'a missing bound identity fails closed'
);
SELECT lives_ok(
  $$SELECT public.ui_assert_resource_read_scope_v1('{"read_scope_types":["client"],"scope_columns":{"client":"client_id"}}', 'client', gen_random_uuid())$$,
  'the explicit client scope with a bound identity is allowed'
);
SELECT * FROM finish();
ROLLBACK;
