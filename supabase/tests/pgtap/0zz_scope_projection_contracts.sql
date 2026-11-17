-- Plan: PLAN-202601-scope-projection-integrity / Step: S95
-- Test: Scope projection contracts prevent org/client drift (RLS safety)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(7);

SELECT has_table('public', 'scope_projection_contracts', 'scope_projection_contracts exists');

SELECT ok(
  COALESCE(c.relrowsecurity, false),
  'RLS enabled on scope_projection_contracts'
)
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'public' AND c.relname = 'scope_projection_contracts';

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_policies p
    WHERE p.schemaname = 'public'
      AND p.tablename = 'scope_projection_contracts'
      AND p.policyname = 'scope_projection_contracts_service_policy'
  ),
  'scope_projection_contracts has service_role policy'
);

-- Guard: referenced tables + columns exist (contract must be internally consistent).
WITH contracts AS (
  SELECT *
  FROM public.scope_projection_contracts
),
missing AS (
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_table' AS kind,
    format('%I.%I', c.table_schema, c.table_name) AS ref
  FROM contracts c
  WHERE to_regclass(format('%I.%I', c.table_schema, c.table_name)) IS NULL
  UNION ALL
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_parent_table' AS kind,
    format('%I.%I', c.parent_schema, c.parent_table) AS ref
  FROM contracts c
  WHERE to_regclass(format('%I.%I', c.parent_schema, c.parent_table)) IS NULL
  UNION ALL
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_join_local_col' AS kind,
    col AS ref
  FROM contracts c
  CROSS JOIN LATERAL unnest(c.join_local_cols) AS col
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.table_schema
      AND ic.table_name = c.table_name
      AND ic.column_name = col
  )
  UNION ALL
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_join_parent_col' AS kind,
    col AS ref
  FROM contracts c
  CROSS JOIN LATERAL unnest(c.join_parent_cols) AS col
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.parent_schema
      AND ic.table_name = c.parent_table
      AND ic.column_name = col
  )
  UNION ALL
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_projection_local_col' AS kind,
    k AS ref
  FROM contracts c
  CROSS JOIN LATERAL jsonb_object_keys(c.projections) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.table_schema
      AND ic.table_name = c.table_name
      AND ic.column_name = k
  )
  UNION ALL
  SELECT
    c.table_schema,
    c.table_name,
    c.parent_schema,
    c.parent_table,
    'missing_projection_parent_col' AS kind,
    (c.projections ->> k) AS ref
  FROM contracts c
  CROSS JOIN LATERAL jsonb_object_keys(c.projections) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.parent_schema
      AND ic.table_name = c.parent_table
      AND ic.column_name = (c.projections ->> k)
  )
)
SELECT diag(format('Scope projection contract %s: %.%.% -> %.%.% (%s)', kind, table_schema, table_name, parent_schema, parent_table, ref))
FROM missing;

WITH contracts AS (
  SELECT *
  FROM public.scope_projection_contracts
),
missing AS (
  SELECT 1
  FROM contracts c
  WHERE to_regclass(format('%I.%I', c.table_schema, c.table_name)) IS NULL
     OR to_regclass(format('%I.%I', c.parent_schema, c.parent_table)) IS NULL
  UNION ALL
  SELECT 1
  FROM contracts c
  CROSS JOIN LATERAL unnest(c.join_local_cols) AS col
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.table_schema
      AND ic.table_name = c.table_name
      AND ic.column_name = col
  )
  UNION ALL
  SELECT 1
  FROM contracts c
  CROSS JOIN LATERAL unnest(c.join_parent_cols) AS col
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.parent_schema
      AND ic.table_name = c.parent_table
      AND ic.column_name = col
  )
  UNION ALL
  SELECT 1
  FROM contracts c
  CROSS JOIN LATERAL jsonb_object_keys(c.projections) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.table_schema
      AND ic.table_name = c.table_name
      AND ic.column_name = k
  )
  UNION ALL
  SELECT 1
  FROM contracts c
  CROSS JOIN LATERAL jsonb_object_keys(c.projections) AS k
  WHERE NOT EXISTS (
    SELECT 1
    FROM information_schema.columns ic
    WHERE ic.table_schema = c.parent_schema
      AND ic.table_name = c.parent_table
      AND ic.column_name = (c.projections ->> k)
  )
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing),
  0,
  'All scope_projection_contracts reference existing tables and columns'
);

-- Guard: triggers are attached for each contracted table.
WITH missing_trigger AS (
  SELECT c.table_schema, c.table_name
  FROM public.scope_projection_contracts c
  GROUP BY c.table_schema, c.table_name
  HAVING NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class r ON r.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND n.nspname = c.table_schema
      AND r.relname = c.table_name
      AND p.proname = 'enforce_scope_projection_contracts'
  )
)
SELECT diag('Missing scope projection trigger on ' || table_schema || '.' || table_name)
FROM missing_trigger;

WITH missing_trigger AS (
  SELECT c.table_schema, c.table_name
  FROM public.scope_projection_contracts c
  GROUP BY c.table_schema, c.table_name
  HAVING NOT EXISTS (
    SELECT 1
    FROM pg_trigger t
    JOIN pg_class r ON r.oid = t.tgrelid
    JOIN pg_namespace n ON n.oid = r.relnamespace
    JOIN pg_proc p ON p.oid = t.tgfoid
    WHERE NOT t.tgisinternal
      AND n.nspname = c.table_schema
      AND r.relname = c.table_name
      AND p.proname = 'enforce_scope_projection_contracts'
  )
)
SELECT is(
  (SELECT COUNT(*)::INT FROM missing_trigger),
  0,
  'All contracted tables have an enforcement trigger'
);

-- Smoke: org/client mismatch is coerced (projection drift impossible)
WITH o1 AS (
  INSERT INTO public.organizations (name, slug)
  VALUES ('pgtap scope org 1', 'pgtap-scope-org-1-' || substr(md5(gen_random_uuid()::text), 1, 10))
  RETURNING id
),
o2 AS (
  INSERT INTO public.organizations (name, slug)
  VALUES ('pgtap scope org 2', 'pgtap-scope-org-2-' || substr(md5(gen_random_uuid()::text), 1, 10))
  RETURNING id
),
c1 AS (
  INSERT INTO public.clients (organization_id, name, slug, status)
  SELECT o1.id, 'pgtap scope client', 'pgtap-scope-client-' || substr(md5(gen_random_uuid()::text), 1, 10), 'active'
  FROM o1
  RETURNING id, organization_id
),
s AS (
  INSERT INTO public.shipments (organization_id, client_id, service_type, tracking_number, box_count, status)
  SELECT o2.id, c1.id, 'delivery', 'PT-SCOPE-' || substr(md5(gen_random_uuid()::text), 1, 10), 1, 'pending'
  FROM o2, c1
  RETURNING organization_id
)
SELECT is(
  (SELECT organization_id::text FROM s),
  (SELECT organization_id::text FROM c1),
  'shipments.organization_id coerces to clients.organization_id'
);

-- Smoke: correct org/client pairing succeeds
SELECT lives_ok(
  $$
    WITH o1 AS (
      INSERT INTO public.organizations (name, slug)
      VALUES ('pgtap scope org ok', 'pgtap-scope-org-ok-' || substr(md5(gen_random_uuid()::text), 1, 10))
      RETURNING id
    ),
    c1 AS (
      INSERT INTO public.clients (organization_id, name, slug, status)
      SELECT o1.id, 'pgtap scope client ok', 'pgtap-scope-client-ok-' || substr(md5(gen_random_uuid()::text), 1, 10), 'active'
      FROM o1
      RETURNING id, organization_id
    )
    INSERT INTO public.shipments (organization_id, client_id, service_type, tracking_number, box_count, status)
    SELECT c1.organization_id, c1.id, 'delivery', 'PT-SCOPE-OK-' || substr(md5(gen_random_uuid()::text), 1, 10), 1, 'pending'
    FROM c1;
  $$,
  'shipments insert with consistent org/client succeeds'
);

SELECT * FROM finish();

ROLLBACK;
