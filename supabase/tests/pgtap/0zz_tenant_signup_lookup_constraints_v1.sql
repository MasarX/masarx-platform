BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'tenant_signup_request_status'
  ),
  'lookup category tenant_signup_request_status exists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_definitions
    WHERE category = 'tenant_signup_review_decision'
  ),
  'lookup category tenant_signup_review_decision exists'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'tenant_signup_request_status'
      AND lv.status = 'active'
      AND lv.value IN ('pending', 'approved', 'rejected')
  ),
  3,
  'tenant signup request status lookup has expected active values'
);

SELECT is(
  (
    SELECT COUNT(*)::INT
    FROM public.lookup_values lv
    JOIN public.lookup_definitions ld ON ld.id = lv.lookup_definition_id
    WHERE ld.category = 'tenant_signup_review_decision'
      AND lv.status = 'active'
      AND lv.value IN ('approved', 'rejected')
  ),
  2,
  'tenant signup review decision lookup has expected active values'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'tenant_signup_requests'
      AND c.column_name = 'status'
      AND c.lookup_category = 'tenant_signup_request_status'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.tenant_signup_requests'::regclass
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) ILIKE '%status%ANY (ARRAY[%'
        OR pg_get_constraintdef(con.oid) ILIKE '%status% IN (%'
        OR pg_get_constraintdef(con.oid) ILIKE '%status% IN(%'
      )
  ),
  'tenant signup status is lookup-contract driven without literal allowlists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.lookup_column_contracts c
    WHERE c.table_schema = 'public'
      AND c.table_name = 'tenant_signup_requests'
      AND c.column_name = 'review_decision'
      AND c.lookup_category = 'tenant_signup_review_decision'
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_constraint con
    WHERE con.conrelid = 'public.tenant_signup_requests'::regclass
      AND con.contype = 'c'
      AND (
        pg_get_constraintdef(con.oid) ILIKE '%review_decision%ANY (ARRAY[%'
        OR pg_get_constraintdef(con.oid) ILIKE '%review_decision% IN (%'
        OR pg_get_constraintdef(con.oid) ILIKE '%review_decision% IN(%'
      )
  ),
  'tenant signup review decision is lookup-contract driven without literal allowlists'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relname = 'tenant_signup_requests'
  ),
  'tenant_signup_requests table remains present'
);

SELECT * FROM finish();

ROLLBACK;
