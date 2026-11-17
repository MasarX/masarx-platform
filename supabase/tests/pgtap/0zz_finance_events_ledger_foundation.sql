-- Test: finance_events ledger foundation (RLS + policies + idempotent write path)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(16);

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

SELECT finish();

ROLLBACK;
