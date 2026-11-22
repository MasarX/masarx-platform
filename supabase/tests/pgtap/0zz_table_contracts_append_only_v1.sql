BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(5);

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

SELECT * FROM finish();
ROLLBACK;
