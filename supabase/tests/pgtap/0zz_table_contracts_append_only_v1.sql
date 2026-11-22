BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT has_column('public', 'table_contracts', 'mutation_policy', 'table_contracts has mutation_policy for append-only guards');

SET LOCAL ROLE service_role;
SELECT is(
  (SELECT mutation_policy FROM public.table_contracts
    WHERE table_schema = 'public' AND table_name = 'billing_invoice_events'),
  'append_only',
  'billing_invoice_events is marked append_only in table_contracts'
);
SELECT is(
  (SELECT mutation_policy FROM public.table_contracts
    WHERE table_schema = 'public' AND table_name = 'finance_events'),
  'append_only',
  'finance_events is marked append_only in table_contracts'
);
RESET ROLE;

WITH relations AS (
  SELECT relid FROM pg_catalog.pg_partition_tree('public.finance_events'::regclass)
  UNION ALL VALUES ('public.settlement_events'::regclass),
    ('public.settlement_batch_finance_events'::regclass), ('public.billing_invoice_events'::regclass)
)
SELECT is(COUNT(t.oid), 0::bigint, 'canonical ledgers have no duplicate table-contract ' || guards.kind || ' guard')
  FROM (VALUES ('row'), ('truncate')) AS guards(kind)
 CROSS JOIN relations
  LEFT JOIN pg_catalog.pg_trigger t
    ON t.tgrelid = relations.relid
   AND t.tgname = 'trg_table_contracts_append_only_' || guards.kind || '_guard'
 GROUP BY guards.kind
 ORDER BY guards.kind;

CREATE TABLE public.test_append_only_ledger (id INTEGER) PARTITION BY RANGE (id);
CREATE TABLE public.test_append_only_ledger_leaf PARTITION OF public.test_append_only_ledger
  FOR VALUES FROM (1) TO (10);
INSERT INTO public.table_contracts (
  table_schema, table_name, created_at_required, updated_at_required, audit_enabled, mutation_policy
) VALUES ('public', 'test_append_only_ledger', FALSE, FALSE, FALSE, 'append_only');

DO $$ BEGIN PERFORM public.apply_append_only_table_contracts_v1('public'); END $$;

INSERT INTO public.test_append_only_ledger VALUES (1);
SELECT throws_ok(
  'TRUNCATE public.test_append_only_ledger_leaf', '23514',
  'public.test_append_only_ledger_leaf is append-only by table_contracts.mutation_policy; use the canonical insert-only write path',
  'a leaf without canonical ledger guards refuses TRUNCATE'
);
SELECT throws_ok(
  'UPDATE public.test_append_only_ledger_leaf SET id = 2', '23514',
  'public.test_append_only_ledger_leaf is append-only by table_contracts.mutation_policy; use the canonical insert-only write path',
  'a leaf without canonical ledger guards refuses UPDATE'
);

UPDATE public.table_contracts SET mutation_policy = 'mutable'
 WHERE table_schema = 'public' AND table_name = 'test_append_only_ledger';
DO $$ BEGIN PERFORM public.apply_append_only_table_contracts_v1('public'); END $$;
SELECT lives_ok('TRUNCATE public.test_append_only_ledger_leaf', 'reconciliation removes leaf guards for a mutable contract');

SELECT * FROM finish();
ROLLBACK;
