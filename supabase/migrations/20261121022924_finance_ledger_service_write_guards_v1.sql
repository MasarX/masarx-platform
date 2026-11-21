BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO pg_catalog, public, pg_temp;

DO $block$
DECLARE
  ledger_partition regclass;
BEGIN
  FOR ledger_partition IN
    SELECT relid FROM pg_partition_tree('public.finance_events'::regclass)
  LOOP
    EXECUTE format('REVOKE UPDATE, DELETE, TRUNCATE ON TABLE %s FROM service_role', ledger_partition);
  END LOOP;
END;
$block$;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE
  public.settlement_events,
  public.settlement_batch_finance_events,
  public.billing_invoice_events
FROM service_role;

COMMIT;
