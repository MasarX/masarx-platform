-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- pgTAP: Direct query contract (authenticated SELECT on core user-facing tables)
BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;
SELECT plan(17);

SELECT ok(has_table_privilege('authenticated', 'public.organizations', 'select'), 'authenticated has SELECT on organizations');
SELECT ok(has_table_privilege('authenticated', 'public.clients', 'select'), 'authenticated has SELECT on clients');
SELECT ok(has_table_privilege('authenticated', 'public.senders', 'select'), 'authenticated has SELECT on senders');
SELECT ok(has_table_privilege('authenticated', 'public.shipments', 'select'), 'authenticated has SELECT on shipments');
SELECT ok(has_table_privilege('authenticated', 'public.recipients', 'select'), 'authenticated has SELECT on recipients');
SELECT ok(has_table_privilege('authenticated', 'public.addresses', 'select'), 'authenticated has SELECT on addresses');
SELECT ok(has_table_privilege('authenticated', 'public.shipment_actions', 'select'), 'authenticated has SELECT on shipment_actions');

SELECT ok(NOT has_table_privilege('anon', 'public.organizations', 'select'), 'anon has no SELECT on organizations');
SELECT ok(NOT has_table_privilege('anon', 'public.clients', 'select'), 'anon has no SELECT on clients');
SELECT ok(NOT has_table_privilege('anon', 'public.senders', 'select'), 'anon has no SELECT on senders');
SELECT ok(NOT has_table_privilege('anon', 'public.shipments', 'select'), 'anon has no SELECT on shipments');
SELECT ok(NOT has_table_privilege('anon', 'public.recipients', 'select'), 'anon has no SELECT on recipients');
SELECT ok(NOT has_table_privilege('anon', 'public.addresses', 'select'), 'anon has no SELECT on addresses');
SELECT ok(NOT has_table_privilege('anon', 'public.shipment_actions', 'select'), 'anon has no SELECT on shipment_actions');

-- Ensure parent table SELECT works even when partition leaves are locked down.
SET LOCAL ROLE authenticated;
SELECT lives_ok('SELECT 1 FROM public.shipments LIMIT 1', 'authenticated can query shipments');
SELECT lives_ok('SELECT 1 FROM public.addresses LIMIT 1', 'authenticated can query addresses');
SELECT lives_ok('SELECT 1 FROM public.recipients LIMIT 1', 'authenticated can query recipients');
RESET ROLE;

SELECT * FROM finish();
ROLLBACK;
