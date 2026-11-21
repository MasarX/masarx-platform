BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO pg_catalog, public, pg_temp;

CREATE OR REPLACE FUNCTION public.enforce_service_only_rls_v1(p_rel regclass)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $$
DECLARE
  v_schema TEXT;
  v_relname TEXT;
  v_policy TEXT;
  v_is_leaf BOOLEAN;
  v_is_finance_tree BOOLEAN;
BEGIN
  SELECT n.nspname, c.relname, c.relkind = 'r'
    INTO v_schema, v_relname, v_is_leaf
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.oid = p_rel;

  IF v_schema IS NULL OR v_relname IS NULL THEN
    RAISE EXCEPTION 'enforce_service_only_rls_v1: relation not found (%).', p_rel;
  END IF;

  EXECUTE format('ALTER TABLE %I.%I ENABLE ROW LEVEL SECURITY', v_schema, v_relname);

  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM PUBLIC', v_schema, v_relname);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM anon', v_schema, v_relname);
  EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM authenticated', v_schema, v_relname);
  v_is_finance_tree := pg_partition_root(p_rel) = to_regclass('public.finance_events');
  IF v_is_finance_tree OR p_rel IN (
    to_regclass('public.finance_event_dedupe'),
    to_regclass('public.settlement_events'),
    to_regclass('public.settlement_batch_finance_events'),
    to_regclass('public.billing_invoice_events')
  ) THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM service_role', v_schema, v_relname);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.%I TO service_role', v_schema, v_relname);

    -- Install local triggers so detaching a partition preserves its ledger guard.
    IF v_is_finance_tree AND v_is_leaf THEN
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER trg_ledger_immutable_rows_v1
           BEFORE UPDATE OR DELETE ON %I.%I FOR EACH ROW
           EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1(''finance_events'')',
        v_schema, v_relname
      );
      EXECUTE format(
        'CREATE OR REPLACE TRIGGER trg_ledger_immutable_truncate_v1
           BEFORE TRUNCATE ON %I.%I FOR EACH STATEMENT
           EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1(''finance_events'')',
        v_schema, v_relname
      );
    END IF;
  ELSE
    EXECUTE format('GRANT ALL ON TABLE %I.%I TO service_role', v_schema, v_relname);
  END IF;

  v_policy := v_relname || '_service_policy';
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = v_schema
      AND tablename = v_relname
      AND policyname = v_policy
  ) THEN
    EXECUTE format(
      'CREATE POLICY %I ON %I.%I FOR ALL TO service_role USING (TRUE) WITH CHECK (TRUE)',
      v_policy, v_schema, v_relname
    );
  END IF;
END;
$$;

-- Reconcile service grants without changing the event tables' authenticated reads.
REVOKE ALL ON TABLE
  public.finance_event_dedupe,
  public.settlement_events,
  public.settlement_batch_finance_events,
  public.billing_invoice_events
FROM service_role;

GRANT SELECT, INSERT ON TABLE
  public.finance_event_dedupe,
  public.settlement_events,
  public.settlement_batch_finance_events,
  public.billing_invoice_events
TO service_role;

CREATE TRIGGER trg_ledger_immutable_rows_v1
  BEFORE UPDATE OR DELETE ON public.finance_event_dedupe FOR EACH ROW
  EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1();

CREATE TRIGGER trg_ledger_immutable_truncate_v1
  BEFORE TRUNCATE ON public.finance_event_dedupe FOR EACH STATEMENT
  EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1();

COMMIT;
