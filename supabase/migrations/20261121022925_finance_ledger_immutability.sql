-- Posted ledger rows are immutable. A parent with ledger rows cannot be deleted.
-- Correct by posting reversals. Retain monthly partitions forever and archive
-- by detaching partitions rather than deleting ledger rows.

BEGIN;
SET LOCAL lock_timeout = '30s';
SET LOCAL search_path TO pg_catalog, public, pg_temp;

CREATE FUNCTION public.immutable_ledger_block_mutation_trg_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO pg_catalog, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only (immutable); use the canonical write path to add a new row instead',
    COALESCE(TG_ARGV[0], TG_TABLE_NAME) USING ERRCODE = '2F003';
END;
$function$;

REVOKE ALL ON FUNCTION public.immutable_ledger_block_mutation_trg_v1() FROM PUBLIC, anon, authenticated;

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
  IF pg_partition_root(p_rel) = to_regclass('public.finance_events') THEN
    EXECUTE format('REVOKE ALL ON TABLE %I.%I FROM service_role', v_schema, v_relname);
    EXECUTE format('GRANT SELECT, INSERT ON TABLE %I.%I TO service_role', v_schema, v_relname);

    -- Install local triggers so detaching a partition preserves its ledger guard.
    IF v_is_leaf THEN
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

DO $block$
DECLARE
  ledger_partition regclass;
  ledger_name text;
BEGIN
  FOR ledger_partition IN
    SELECT relid FROM pg_partition_tree('public.finance_events'::regclass)
  LOOP
    PERFORM public.enforce_service_only_rls_v1(ledger_partition);
  END LOOP;

  FOREACH ledger_name IN ARRAY ARRAY[
    'settlement_events', 'settlement_batch_finance_events', 'billing_invoice_events'
  ]
  LOOP
    EXECUTE format(
      'CREATE TRIGGER trg_ledger_immutable_rows_v1
         BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW
         EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1()',
      ledger_name
    );
    EXECUTE format(
      'CREATE TRIGGER trg_ledger_immutable_truncate_v1
         BEFORE TRUNCATE ON public.%I FOR EACH STATEMENT
         EXECUTE FUNCTION public.immutable_ledger_block_mutation_trg_v1()',
      ledger_name
    );
  END LOOP;
END;
$block$;

REVOKE UPDATE, DELETE, TRUNCATE ON TABLE public.finance_event_dedupe FROM service_role;

UPDATE public.partitioning_config
   SET config = jsonb_set(COALESCE(config, '{}'::jsonb), '{retention_policy}', '"archive"'::jsonb)
 WHERE table_name = 'finance_events'
   AND (config->>'retention_policy') IS DISTINCT FROM 'archive';

ALTER TABLE public.partitioning_config
  ADD CONSTRAINT finance_events_archive_only
  CHECK (table_name <> 'finance_events' OR COALESCE(config->>'retention_policy', 'archive') = 'archive');

COMMIT;
