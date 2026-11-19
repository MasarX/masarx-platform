-- Repair Console/API write RPC correlation ids so UUID-typed audit ledgers receive
-- canonical UUID values instead of legacy 16-character hex text.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605031530_uuid_correlation_id_contract_repair_v1'));
SET search_path TO public, extensions, pg_temp;

DO $$
DECLARE
  v_function RECORD;
  v_definition TEXT;
  v_repaired_count INTEGER := 0;
BEGIN
  FOR v_function IN
    SELECT
      p.oid,
      n.nspname,
      p.proname,
      pg_get_functiondef(p.oid) AS definition
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prolang = (SELECT oid FROM pg_language WHERE lanname = 'plpgsql')
      AND pg_get_functiondef(p.oid) LIKE '%v_correlation_id TEXT := encode(gen_random_bytes(8), ''hex'');%'
    ORDER BY n.nspname, p.proname
  LOOP
    v_definition := replace(
      v_function.definition,
      'v_correlation_id TEXT := encode(gen_random_bytes(8), ''hex'');',
      'v_correlation_id TEXT := gen_random_uuid()::text;'
    );

    IF v_definition = v_function.definition THEN
      RAISE EXCEPTION 'Failed to rewrite correlation id initializer for %.%',
        v_function.nspname, v_function.proname;
    END IF;

    EXECUTE v_definition;
    v_repaired_count := v_repaired_count + 1;
  END LOOP;

  IF v_repaired_count = 0 THEN
    RAISE EXCEPTION 'No legacy hex correlation-id functions found to repair';
  END IF;
END $$;

SELECT pg_advisory_unlock(hashtext('202605031530_uuid_correlation_id_contract_repair_v1'));
COMMIT;
