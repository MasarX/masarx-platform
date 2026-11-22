BEGIN;
SET LOCAL search_path TO public, pgtap, extensions, pg_temp;
CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(1);

SET LOCAL ROLE service_role;
SELECT is(
  (SELECT mutation_policy FROM public.table_contracts
    WHERE table_schema = 'public' AND table_name = 'billing_invoice_events'),
  'append_only',
  'billing_invoice_events is marked append_only in table_contracts'
);
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
