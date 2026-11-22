-- Migration: Row-driven append-only ledger table contracts
-- Date: 2026-04-28
--
-- Purpose:
--   - Make immutable ledger intent enforceable at the database layer.
--   - Keep the control row-driven through table_contracts.mutation_policy.
--   - Deny UPDATE, DELETE, and TRUNCATE for append-only ledgers while retaining
--     canonical insert-only RPC paths.
BEGIN;
SELECT pg_advisory_xact_lock(hashtext('20261122029000_append_only_ledger_table_contracts_v1'));
SET LOCAL search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '5s';

ALTER TABLE public.table_contracts
  ADD COLUMN IF NOT EXISTS mutation_policy TEXT NOT NULL DEFAULT 'mutable';


INSERT INTO public.lookup_definitions (category, description, owner_role, approval_policy, is_mutable)
VALUES (
  'table_contract_mutation_policy',
  'Mutation policies used by table_contracts to reconcile database write guards.',
  'platform',
  NULL,
  FALSE
)
ON CONFLICT (category) DO UPDATE
   SET description = EXCLUDED.description,
       owner_role = EXCLUDED.owner_role,
       approval_policy = EXCLUDED.approval_policy,
       is_mutable = EXCLUDED.is_mutable,
       updated_at = now();

INSERT INTO public.lookup_values (
  lookup_definition_id,
  value,
  label,
  description,
  sort_order,
  is_default,
  metadata
)
SELECT ld.id, v.value, v.label, v.description, v.sort_order, v.is_default, v.metadata
  FROM public.lookup_definitions ld
  CROSS JOIN (
    VALUES
      ('mutable', 'Mutable', 'Normal table mutation behavior is allowed.', 10, TRUE, '{}'::jsonb),
      ('append_only', 'Append only', 'UPDATE, DELETE, and TRUNCATE are denied by mutation guards.', 20, FALSE, '{}'::jsonb)
  ) AS v(value, label, description, sort_order, is_default, metadata)
 WHERE ld.category = 'table_contract_mutation_policy'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
   SET label = EXCLUDED.label,
       description = EXCLUDED.description,
       sort_order = EXCLUDED.sort_order,
       is_default = EXCLUDED.is_default,
       metadata = EXCLUDED.metadata,
       status = 'active',
       retired_at = NULL,
       updated_at = now();

COMMENT ON COLUMN public.table_contracts.mutation_policy IS
  'Row-driven mutation policy for table_contracts: append_only requires guards against UPDATE, DELETE, and TRUNCATE.';

CREATE OR REPLACE FUNCTION public.enforce_table_contract_mutation_policy_lookup_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM public.lookup_definitions ld
      JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
     WHERE ld.category = 'table_contract_mutation_policy'
       AND lv.value = NEW.mutation_policy
       AND lv.status = 'active'
       AND (lv.effective_from IS NULL OR lv.effective_from <= now())
       AND (lv.effective_until IS NULL OR lv.effective_until > now())
  ) THEN
    RAISE EXCEPTION 'Invalid table_contracts.mutation_policy %. Configure table_contract_mutation_policy lookup_values first.', NEW.mutation_policy
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

COMMENT ON FUNCTION public.enforce_table_contract_mutation_policy_lookup_v1() IS
  'Validates table_contracts.mutation_policy against row-driven table_contract_mutation_policy lookup values.';

CREATE OR REPLACE TRIGGER trg_table_contracts_mutation_policy_lookup_v1
  BEFORE INSERT OR UPDATE OF mutation_policy ON public.table_contracts
  FOR EACH ROW
  EXECUTE FUNCTION public.enforce_table_contract_mutation_policy_lookup_v1();

CREATE OR REPLACE FUNCTION public.reject_append_only_table_mutation_v1()
RETURNS trigger
LANGUAGE plpgsql
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  RAISE EXCEPTION '% is append-only by table_contracts.mutation_policy; use the canonical insert-only write path',
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME
    USING ERRCODE = '23514';
END;
$function$;

COMMENT ON FUNCTION public.reject_append_only_table_mutation_v1() IS
  'Trigger guard used by table_contracts.mutation_policy=append_only to deny UPDATE, DELETE, and TRUNCATE.';

CREATE OR REPLACE FUNCTION public.apply_append_only_table_contracts_v1(
  p_table_schema TEXT DEFAULT 'public'
)
RETURNS TABLE (
  table_schema TEXT,
  table_name TEXT,
  mutation_policy TEXT,
  row_guard_action TEXT,
  truncate_guard_action TEXT
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  r RECORD;
  v_guard RECORD;
  v_rel REGCLASS;
  v_default_timeout BOOLEAN := current_setting('lock_timeout') = '0';
BEGIN
  IF p_table_schema IS DISTINCT FROM 'public' THEN
    RAISE EXCEPTION 'Append-only table contracts are supported only in the public schema'
      USING ERRCODE = '22023';
  END IF;

  IF v_default_timeout THEN
    SET LOCAL lock_timeout = '5s';
  END IF;

  FOR r IN
    SELECT tc.table_schema,
           tc.table_name,
           tc.mutation_policy
      FROM public.table_contracts tc
     WHERE tc.table_schema = COALESCE(NULLIF(btrim(p_table_schema), ''), 'public')
     ORDER BY tc.table_schema, tc.table_name
  LOOP
    v_rel := to_regclass(format('%I.%I', r.table_schema, r.table_name));
    IF v_rel IS NULL OR NOT EXISTS (
      SELECT FROM pg_catalog.pg_class WHERE oid = v_rel AND relkind IN ('r', 'p')
    ) THEN
      CONTINUE;
    END IF;

    row_guard_action := CASE WHEN r.mutation_policy = 'append_only' THEN 'existing' ELSE 'dropped' END;
    truncate_guard_action := row_guard_action;

    -- Leaf-local guards survive partition detach. Statement triggers on the
    -- root alone cannot block TRUNCATE issued directly against a leaf.
    FOR v_guard IN
      WITH relations AS (
        SELECT v_rel AS relid, relkind = 'r' AS isleaf, 0 AS depth
          FROM pg_catalog.pg_class WHERE oid = v_rel
        UNION ALL
        SELECT relid, isleaf, level
          FROM pg_catalog.pg_partition_tree(v_rel) WHERE isleaf AND relid <> v_rel
      ), guards AS (
        SELECT relid, isleaf, depth, kind, events, trigger_level,
               'trg_table_contracts_append_only_' || kind || '_guard' AS guard_name,
               EXISTS (
                 SELECT FROM pg_catalog.pg_trigger t
                  WHERE t.tgrelid = relid AND t.tgname = canonical_name
                    AND t.tgfoid = 'public.immutable_ledger_block_mutation_trg_v1()'::regprocedure
                    AND t.tgenabled IN ('O', 'A')
               ) AS canonical
          FROM relations
         CROSS JOIN (VALUES
           ('row', 'UPDATE OR DELETE', 'ROW', 'trg_ledger_immutable_rows_v1'),
           ('truncate', 'TRUNCATE', 'STATEMENT', 'trg_ledger_immutable_truncate_v1')
         ) AS kinds(kind, events, trigger_level, canonical_name)
      )
      SELECT *, NOT canonical AND (isleaf OR (
               kind = 'truncate' AND NOT COALESCE(
                 bool_and(canonical) FILTER (WHERE isleaf) OVER (PARTITION BY kind), FALSE
               )
             )) AS needs_guard
        FROM guards
       ORDER BY depth, kind
    LOOP
      IF r.mutation_policy = 'append_only' AND v_guard.needs_guard THEN
        EXECUTE format(
          'CREATE OR REPLACE TRIGGER %I BEFORE %s ON %s FOR EACH %s EXECUTE FUNCTION public.reject_append_only_table_mutation_v1()',
          v_guard.guard_name, v_guard.events, v_guard.relid, v_guard.trigger_level
        );
        IF v_guard.kind = 'row' THEN
          row_guard_action := 'created';
        ELSE
          truncate_guard_action := 'created';
        END IF;
      ELSIF EXISTS (
        SELECT FROM pg_catalog.pg_trigger t
         WHERE t.tgrelid = v_guard.relid AND t.tgname = v_guard.guard_name
           AND NOT t.tgisinternal AND t.tgparentid = 0
      ) THEN
        EXECUTE format('DROP TRIGGER %I ON %s', v_guard.guard_name, v_guard.relid);
      END IF;
    END LOOP;

    table_schema := r.table_schema;
    table_name := r.table_name;
    mutation_policy := r.mutation_policy;
    RETURN NEXT;
  END LOOP;

  IF v_default_timeout THEN
    SET LOCAL lock_timeout = '0';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.apply_append_only_table_contracts_v1(TEXT) IS
  'Reconciles append-only mutation guard triggers for tables with table_contracts.mutation_policy=append_only.';

REVOKE ALL ON FUNCTION public.apply_append_only_table_contracts_v1(TEXT) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.apply_append_only_table_contracts_v1(TEXT) TO service_role;

UPDATE public.table_contracts
   SET mutation_policy = 'append_only',
       notes = CASE
         WHEN notes IS NULL OR btrim(notes) = '' THEN 'Append-only ledger; direct UPDATE/DELETE/TRUNCATE denied.'
         WHEN notes ILIKE '%append-only%' THEN notes
         ELSE notes || ' Append-only mutation guard enforced.'
       END,
       updated_at = now()
 WHERE table_schema = 'public'
   AND table_name IN (
     'finance_events',
     'settlement_events',
     'settlement_batch_finance_events',
     'billing_invoice_events'
   );

SELECT public.apply_append_only_table_contracts_v1('public');

COMMIT;
