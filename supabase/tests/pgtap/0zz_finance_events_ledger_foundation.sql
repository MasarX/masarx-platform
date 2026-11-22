-- Test: finance_events ledger foundation (RLS + policies + idempotent write path)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(76);

SELECT has_table('public', 'finance_events', 'finance_events table exists');
SELECT has_table('public', 'finance_event_dedupe', 'finance_event_dedupe table exists');

SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='finance_events'), 'RLS enabled on finance_events');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='finance_event_dedupe'), 'RLS enabled on finance_event_dedupe');

SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='finance_events'), 'finance_events has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='finance_event_dedupe'), 'finance_event_dedupe has policies');

SELECT ok(NOT has_table_privilege('anon', 'public.finance_events', 'select'), 'anon has no SELECT on finance_events');
SELECT ok(NOT has_table_privilege('authenticated', 'public.finance_events', 'select'), 'authenticated has no SELECT on finance_events');
SELECT ok(NOT has_table_privilege('anon', 'public.finance_event_dedupe', 'select'), 'anon has no SELECT on finance_event_dedupe');
SELECT ok(NOT has_table_privilege('authenticated', 'public.finance_event_dedupe', 'select'), 'authenticated has no SELECT on finance_event_dedupe');

SELECT ok(EXISTS(SELECT 1 FROM public.partitioning_config WHERE table_name = 'finance_events'), 'finance_events registered in partitioning_config');

SELECT ok(EXISTS(
  SELECT 1
  FROM public.settings s
  WHERE s.category = 'cod_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
), 'cod_policy global settings seeded');

SELECT ok(EXISTS(
  SELECT 1
  FROM public.settings s
  WHERE s.category = 'settlement_policy'
    AND s.scope_type = 'global'
    AND s.scope_id IS NULL
), 'settlement_policy global settings seeded');

SELECT has_function('public', 'record_finance_event_v1', ARRAY['jsonb'], 'record_finance_event_v1(jsonb) exists');

SELECT has_column('public', 'table_contracts', 'mutation_policy', 'table_contracts has mutation_policy for append-only guards');
SELECT is(
  (
    SELECT mutation_policy
    FROM public.table_contracts
    WHERE table_schema = 'public'
      AND table_name = 'finance_events'
  ),
  'append_only',
  'finance_events is marked append_only in table_contracts'
);
SELECT ok(EXISTS(
  SELECT 1
  FROM pg_trigger
  WHERE tgrelid = 'public.finance_events'::regclass
    AND tgname = 'trg_table_contracts_append_only_row_guard'
), 'finance_events has append-only row guard trigger');
SELECT ok(EXISTS(
  SELECT 1
  FROM pg_trigger
  WHERE tgrelid = 'public.finance_events'::regclass
    AND tgname = 'trg_table_contracts_append_only_truncate_guard'
), 'finance_events has append-only truncate guard trigger');

-- Fixture: ensure an organization exists for FK constraints.
INSERT INTO public.organizations (id, name, slug, timezone, locale, billing_status)
VALUES (
  '0bb00000-0000-0000-0000-000000000001',
  'PGTAP Finance Org',
  '0bb00000-0000-0000-0000-000000000001',
  'UTC',
  'en-US',
  'active'
)
ON CONFLICT (id) DO NOTHING;

-- Idempotency: same organization_id + idempotency_key returns the same finance_event_id and inserts once.
SELECT set_config(
  'test.finance_event_id_1',
  (
    SELECT finance_event_id::text
    FROM public.record_finance_event_v1(
      jsonb_build_object(
        'organization_id', '0bb00000-0000-0000-0000-000000000001',
        'event_type', 'cod_collected',
        'direction', 'in',
        'amount', 100,
        'currency', 'SAR',
        'account_type', 'driver',
        'account_id', 'aaaaaaaa-0000-0000-0000-000000000001',
        'subject_type', 'shipment',
        'subject_id', '11111111-0000-0000-0000-000000000001',
        'idempotency_key', 'pgtap-finance-evt-001',
        'metadata', jsonb_build_object('test', true)
      )
    )
    LIMIT 1
  ),
  TRUE
);

SELECT is(
  (
    SELECT finance_event_id::text
    FROM public.record_finance_event_v1(
      jsonb_build_object(
        'organization_id', '0bb00000-0000-0000-0000-000000000001',
        'event_type', 'cod_collected',
        'direction', 'in',
        'amount', 100,
        'currency', 'SAR',
        'account_type', 'driver',
        'account_id', 'aaaaaaaa-0000-0000-0000-000000000001',
        'subject_type', 'shipment',
        'subject_id', '11111111-0000-0000-0000-000000000001',
        'idempotency_key', 'pgtap-finance-evt-001',
        'metadata', jsonb_build_object('test', true)
      )
    )
    LIMIT 1
  ),
  current_setting('test.finance_event_id_1'),
  'record_finance_event_v1 idempotency returns same finance_event_id'
);

SELECT is(
  (
    SELECT count(*)
    FROM public.finance_events
    WHERE organization_id = '0bb00000-0000-0000-0000-000000000001'
      AND idempotency_key = 'pgtap-finance-evt-001'
  ),
  1::bigint,
  'only one finance_events row inserted for idempotency_key'
);

-- Recreate next month's empty leaves within this rollback-only test.
DO $block$
DECLARE
  next_month timestamptz := date_trunc('month', now()) + INTERVAL '1 month';
  leaf record;
  has_rows boolean;
BEGIN
  FOR leaf IN
    SELECT part.relid, part.parentrelid, child.relname
      FROM pg_partition_tree('public.finance_events'::regclass) part
      JOIN pg_class child ON child.oid = part.relid
      JOIN pg_class parent ON parent.oid = part.parentrelid
     WHERE part.isleaf
       AND child.relname = public.generate_partition_name_range_monthly('finance_events', next_month)
                           || '_p' || COALESCE((regexp_match(parent.relname, '_p([0-9]+)$'))[1], '0')
  LOOP
    EXECUTE format('SELECT EXISTS (SELECT 1 FROM %s)', leaf.relid) INTO has_rows;
    IF has_rows THEN
      RAISE EXCEPTION 'next-month finance ledger fixture must be empty';
    END IF;
    EXECUTE format('ALTER TABLE %s DETACH PARTITION %s', leaf.parentrelid, leaf.relid);
    EXECUTE format('ALTER TABLE %s RENAME TO %I', leaf.relid, 'pgtap_previous_' || leaf.relname);
  END LOOP;
END;
$block$;

UPDATE public.partitioning_config
SET partitions_ahead = CASE WHEN table_name = 'finance_events' THEN 2 ELSE 0 END
WHERE partition_strategy IN ('RANGE', 'HASH+RANGE');

CREATE TEMP TABLE pgtap_next_finance_partitions ON COMMIT DROP AS
SELECT partition_name
  FROM public.create_next_partitions()
 WHERE table_name = 'finance_events'
   AND partition_start = date_trunc('month', now()) + INTERVAL '1 month'
   AND created;

SELECT ok(
  EXISTS (SELECT 1 FROM pgtap_next_finance_partitions)
  AND NOT EXISTS (
    SELECT 1 FROM pgtap_next_finance_partitions part
    CROSS JOIN LATERAL (
      SELECT to_regclass(format('public.%I', part.partition_name)) AS oid
    ) rel
    WHERE rel.oid IS NULL
       OR NOT has_table_privilege('service_role', rel.oid, 'SELECT')
       OR NOT has_table_privilege('service_role', rel.oid, 'INSERT')
       OR has_table_privilege('service_role', rel.oid, 'UPDATE, DELETE, TRUNCATE')
  ),
  'fresh next-month finance partitions allow service SELECT and INSERT without mutation'
);

SELECT ok(
  NOT has_table_privilege('service_role', 'public.finance_event_dedupe', 'UPDATE, DELETE, TRUNCATE'),
  'service role cannot rewrite finance event deduplication keys'
);

SELECT ok(
  has_function_privilege(role_name::name, routine_signature, 'EXECUTE') = can_execute,
  format('%s %s EXECUTE %s', role_name, CASE WHEN can_execute THEN 'can' ELSE 'cannot' END, routine_signature)
)
FROM (
  VALUES ('anon', false), ('authenticated', false), ('service_role', true)
) AS roles(role_name, can_execute)
CROSS JOIN (
  VALUES
    ('public.marketplace_record_finance_event_v1(uuid,text,text,numeric,text,text,uuid,jsonb,text)'),
    ('public.marketplace_create_posted_settlement_batch_v1(uuid,text,uuid,uuid,timestamptz,jsonb,text)')
) AS writers(routine_signature)
ORDER BY routine_signature, role_name;

SELECT ok(NOT EXISTS (
  SELECT 1 FROM pg_partition_tree('public.finance_events'::regclass) AS part
  WHERE has_table_privilege('service_role', part.relid, 'UPDATE, DELETE, TRUNCATE')
), 'service role cannot rewrite current finance ledger partitions');

SELECT ok(NOT EXISTS (
  SELECT 1 FROM unnest(ARRAY[
    'public.settlement_events', 'public.settlement_batch_finance_events', 'public.billing_invoice_events'
  ]) AS relation(name)
  WHERE has_table_privilege('service_role', relation.name, 'UPDATE, DELETE, TRUNCATE')
), 'service role cannot rewrite settlement or billing events');

-- Removing either trigger from one fresh leaf fails the corresponding catalog check.
SELECT ok(
  EXISTS (SELECT 1 FROM pgtap_next_finance_partitions)
  AND NOT EXISTS (
    SELECT 1
    FROM pgtap_next_finance_partitions part
    WHERE NOT EXISTS (
      SELECT 1
      FROM pg_trigger t
      WHERE t.tgrelid = to_regclass(format('public.%I', part.partition_name))
        AND t.tgname = guard.name
        AND t.tgtype = guard.event_mask
        AND t.tgfoid = 'public.immutable_ledger_block_mutation_trg_v1()'::regprocedure
        AND t.tgenabled IN ('O', 'A')
        AND NOT t.tgisinternal
        AND t.tgparentid = 0
    )
  ),
  format('each fresh finance leaf has its own enabled %s trigger', guard.label)
)
FROM (VALUES
  ('trg_ledger_immutable_rows_v1', 27, 'BEFORE UPDATE OR DELETE'),
  ('trg_ledger_immutable_truncate_v1', 34, 'BEFORE TRUNCATE')
) AS guard(name, event_mask, label)
ORDER BY guard.event_mask;

SELECT set_config(
  'test.finance_event_leaf_oid',
  (
    SELECT tableoid::text
    FROM public.finance_events
    WHERE organization_id = '0bb00000-0000-0000-0000-000000000001'
      AND id = current_setting('test.finance_event_id_1')::uuid
  ),
  true
);

-- Each owner probe targets a fixture row, so removing its row guard loses 2F003.
WITH ledgers(name, relation, row_filter) AS (
  VALUES
    ('finance_events', current_setting('test.finance_event_leaf_oid')::oid::regclass,
      format('organization_id = %L::uuid AND id = %L::uuid',
        '0bb00000-0000-0000-0000-000000000001', current_setting('test.finance_event_id_1'))),
    ('finance_event_dedupe', 'public.finance_event_dedupe'::regclass,
      'organization_id = ''0bb00000-0000-0000-0000-000000000001''::uuid AND idempotency_key = ''pgtap-finance-evt-001''')
)
SELECT throws_ok(
  format(op.statement, ledger.relation, ledger.row_filter),
  '2F003',
  format('%s is append-only (immutable); use the canonical write path to add a new row instead', ledger.name),
  format('owner cannot %s a fixture row in %s', op.verb, ledger.relation)
)
FROM ledgers AS ledger
CROSS JOIN (VALUES
  ('UPDATE', 'UPDATE %s SET organization_id = organization_id WHERE %s'),
  ('DELETE', 'DELETE FROM %s WHERE %s')
) AS op(verb, statement)
ORDER BY ledger.name, op.verb;

-- Exact messages prevent a cascaded table's guard from masking a missing target guard.
SELECT throws_ok(
  format('TRUNCATE TABLE %s%s', ledger.relation, ledger.cascade_clause),
  '2F003',
  format('%s is append-only (immutable); use the canonical write path to add a new row instead', ledger.name),
  format('owner cannot TRUNCATE %s', ledger.relation)
)
FROM (VALUES
  ('finance_event_dedupe', 'public.finance_event_dedupe'::regclass, ''),
  ('settlement_events', 'public.settlement_events'::regclass, ''),
  ('settlement_batch_finance_events', 'public.settlement_batch_finance_events'::regclass, ''),
  ('billing_invoice_events', 'public.billing_invoice_events'::regclass, ''),
  ('finance_events', current_setting('test.finance_event_leaf_oid')::oid::regclass, ' CASCADE')
) AS ledger(name, relation, cascade_clause)
ORDER BY ledger.name;

-- Reconciliation must preserve authenticated access used by scoped read paths.
SELECT ok(
  has_table_privilege('authenticated', ledger.relation, 'SELECT'),
  format('authenticated keeps its scoped SELECT on %s', ledger.relation)
)
FROM (VALUES
  ('public.settlement_events'::regclass),
  ('public.settlement_batch_finance_events'::regclass),
  ('public.billing_invoice_events'::regclass)
) AS ledger(relation)
ORDER BY ledger.relation::text;

-- Run maintenance as the owner in this rollback-only fixture. If a table
-- falls into the general GRANT ALL branch, the ACL probes below must fail.
DO $block$
BEGIN
  PERFORM public.enforce_service_only_rls_v1('public.finance_event_dedupe'::regclass);
  PERFORM public.enforce_service_only_rls_v1('public.settlement_events'::regclass);
  PERFORM public.enforce_service_only_rls_v1('public.settlement_batch_finance_events'::regclass);
  PERFORM public.enforce_service_only_rls_v1('public.billing_invoice_events'::regclass);
END;
$block$;

-- Check the effective grants immediately after owner maintenance.
SELECT ok(
  has_table_privilege('service_role', ledger.relation, acl.privilege) = acl.allowed,
  format('service_role %s %s on %s',
    CASE WHEN acl.allowed THEN 'retains' ELSE 'lacks' END, acl.privilege, ledger.relation)
)
FROM (VALUES
  ('public.finance_event_dedupe'::regclass),
  ('public.settlement_events'::regclass),
  ('public.settlement_batch_finance_events'::regclass),
  ('public.billing_invoice_events'::regclass)
) AS ledger(relation)
CROSS JOIN (VALUES
  ('SELECT', true),
  ('INSERT', true),
  ('TRIGGER', false),
  ('REFERENCES', false)
) AS acl(privilege, allowed)
ORDER BY ledger.relation::text, acl.privilege;

SELECT ok(
  NOT has_function_privilege('service_role', 'public.enforce_service_only_rls_v1(regclass)', 'EXECUTE'),
  'replacing the ledger helper preserves the service_role EXECUTE revoke'
);

-- Zero-row DML isolates the ACL from row triggers. TRUNCATE uses RESTRICT to
-- avoid obscuring a restored target grant with a dependent table's ACL.
SET LOCAL ROLE service_role;

SELECT throws_ok(
  format(op.statement, ledger.relation),
  '42501',
  NULL,
  format('service_role cannot %s %s', op.verb, ledger.relation)
)
FROM (VALUES
  ('public.finance_event_dedupe'::regclass),
  ('public.settlement_events'::regclass),
  ('public.settlement_batch_finance_events'::regclass),
  ('public.billing_invoice_events'::regclass),
  (current_setting('test.finance_event_leaf_oid')::oid::regclass)
) AS ledger(relation)
CROSS JOIN (VALUES
  ('UPDATE', $sql$UPDATE %s SET organization_id = '0bb00000-0000-0000-0000-000000000001'::uuid WHERE false$sql$),
  ('DELETE', 'DELETE FROM %s WHERE false'),
  ('TRUNCATE', 'TRUNCATE TABLE %s RESTRICT')
) AS op(verb, statement)
ORDER BY ledger.relation::text, op.verb;

RESET ROLE;

SELECT finish();

ROLLBACK;
