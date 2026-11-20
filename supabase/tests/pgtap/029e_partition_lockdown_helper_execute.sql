BEGIN;
CREATE EXTENSION IF NOT EXISTS pgtap;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
SET LOCAL statement_timeout = '30s';
SELECT plan(9);

-- Mutation: inherited PUBLIC EXECUTE or a direct re-grant to anon fails this ACL assertion.
SELECT ok(NOT has_function_privilege('anon', 'public.enforce_service_only_rls_v1(regclass)', 'EXECUTE'),
  'anon cannot execute the single-relation helper');
-- Mutation: without the single-relation revoke, authenticated inherits PUBLIC EXECUTE.
SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_service_only_rls_v1(regclass)', 'EXECUTE'),
  'authenticated cannot execute the single-relation helper');
-- Mutation: without the single-relation revoke, service_role inherits PUBLIC EXECUTE.
SELECT ok(NOT has_function_privilege('service_role', 'public.enforce_service_only_rls_v1(regclass)', 'EXECUTE'),
  'service_role cannot execute the single-relation helper');
-- Mutation: inherited PUBLIC EXECUTE or a direct re-grant to anon fails this ACL assertion.
SELECT ok(NOT has_function_privilege('anon', 'public.enforce_partition_tree_service_only_v1(regclass)', 'EXECUTE'),
  'anon cannot execute the partition-tree helper');
-- Mutation: without the partition-tree revoke, authenticated inherits PUBLIC EXECUTE.
SELECT ok(NOT has_function_privilege('authenticated', 'public.enforce_partition_tree_service_only_v1(regclass)', 'EXECUTE'),
  'authenticated cannot execute the partition-tree helper');
-- Mutation: without the partition-tree revoke, service_role inherits PUBLIC EXECUTE.
SELECT ok(NOT has_function_privilege('service_role', 'public.enforce_partition_tree_service_only_v1(regclass)', 'EXECUTE'),
  'service_role cannot execute the partition-tree helper');

-- Mutation: without the single-relation revoke, service_role reaches the definer
-- and the call on an already service-only table succeeds instead of returning 42501.
SET LOCAL ROLE service_role;
SELECT throws_ok(
  $$SELECT public.enforce_service_only_rls_v1('public.finance_event_dedupe'::regclass)$$,
  '42501', 'permission denied for function enforce_service_only_rls_v1',
  'service_role is denied at the single-relation function ACL'
);
RESET ROLE;

-- Mutation: granting anon USAGE on public changes the denial to the function ACL.
-- The privilege assertion above detects a direct EXECUTE re-grant to anon.
SET LOCAL ROLE anon;
SELECT throws_ok(
  $$SELECT public.enforce_service_only_rls_v1('public.finance_event_dedupe'::regclass)$$,
  '42501', 'permission denied for schema public',
  'anon is denied (no USAGE on schema public)'
);
RESET ROLE;

-- Limit owner-run partition creation to one synthetic leaf.
UPDATE public.partitioning_config
SET partitions_ahead = 0
WHERE partition_strategy IN ('RANGE', 'HASH+RANGE');

CREATE TABLE public.pgtap_definer_leaf (
  created_at timestamptz NOT NULL
) PARTITION BY RANGE (created_at);

INSERT INTO public.partitioning_config (
  table_name, partition_strategy, partition_key, partition_interval,
  partitions_ahead, retention_months, config
) VALUES (
  'pgtap_definer_leaf', 'RANGE', 'created_at', 'monthly',
  1, NULL, '{"retention_policy":"archive"}'::jsonb
);

DO $$
BEGIN
  PERFORM public.create_next_partitions();
END;
$$;

-- Mutation: removing either revoke restores PUBLIC EXECUTE. Revoking the owner's
-- access or losing leaf lockdown also breaks this owner-only maintenance check.
SELECT ok(
  (
    SELECT count(*) = 1 AND bool_and(
      child.relrowsecurity
      AND has_table_privilege('service_role', child.oid, 'SELECT')
      AND NOT has_table_privilege('anon', child.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      AND NOT has_table_privilege('authenticated', child.oid, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER')
      AND EXISTS (
        SELECT 1 FROM pg_policy AS policy
        WHERE policy.polrelid = child.oid
          AND policy.polroles = ARRAY['service_role'::regrole::oid]
          AND policy.polcmd = '*'
      )
    )
    FROM pg_inherits AS inheritance
    JOIN pg_class AS child ON child.oid = inheritance.inhrelid
    WHERE inheritance.inhparent = 'public.pgtap_definer_leaf'::regclass
  )
  AND NOT EXISTS (
    SELECT 1
    FROM pg_proc AS proc
    CROSS JOIN LATERAL aclexplode(coalesce(proc.proacl, acldefault('f', proc.proowner))) AS acl
    WHERE proc.oid IN (
      'public.enforce_service_only_rls_v1(regclass)'::regprocedure,
      'public.enforce_partition_tree_service_only_v1(regclass)'::regprocedure
    )
      AND acl.grantee = 0 AND acl.privilege_type = 'EXECUTE'
  ),
  'the owner can create a locked-down leaf while both helpers deny PUBLIC execute'
);

SELECT finish();
ROLLBACK;
