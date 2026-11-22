BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.apply_lookup_column_contracts(p_table_schema TEXT DEFAULT 'public')
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
  rec RECORD;
  v_cols TEXT;
  v_fq TEXT;
  v_trg TEXT;
  v_default_timeout BOOLEAN := current_setting('lock_timeout') = '0';
BEGIN
  IF v_default_timeout THEN
    SET LOCAL lock_timeout = '5s';
  END IF;

  FOR rec IN
    SELECT table_schema, table_name
    FROM public.lookup_column_contracts
    WHERE table_schema = p_table_schema
    GROUP BY table_schema, table_name
    ORDER BY table_schema, table_name
  LOOP
    v_fq := format('%I.%I', rec.table_schema, rec.table_name);
    IF to_regclass(v_fq) IS NULL THEN
      CONTINUE;
    END IF;

    SELECT string_agg(format('%I', column_name), ', ' ORDER BY column_name)
    INTO v_cols
    FROM public.lookup_column_contracts
    WHERE table_schema = rec.table_schema
      AND table_name = rec.table_name;

    IF v_cols IS NULL OR btrim(v_cols) = '' THEN
      CONTINUE;
    END IF;

    v_trg := 'trg_lookup_contract_' || substr(md5(rec.table_schema || '.' || rec.table_name), 1, 12);

    -- Replacing a trigger uses a lock compatible with AccessShareLock.
    EXECUTE format(
      'CREATE OR REPLACE TRIGGER %I BEFORE INSERT OR UPDATE OF %s ON %s FOR EACH ROW EXECUTE FUNCTION public.enforce_lookup_column_contracts()',
      v_trg,
      v_cols,
      v_fq
    );
  END LOOP;

  IF v_default_timeout THEN
    SET LOCAL lock_timeout = '0';
  END IF;
END;
$$;

COMMIT;
