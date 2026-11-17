-- Test: alert_rules and alert_triggers RLS/grants hardening

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(8);

SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='alert_rules'), 'RLS enabled on alert_rules');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='alert_triggers'), 'RLS enabled on alert_triggers');

SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='alert_rules'), 'alert_rules has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='alert_triggers'), 'alert_triggers has policies');

SELECT ok(NOT has_table_privilege('anon', 'public.alert_rules', 'select'), 'anon has no SELECT on alert_rules');
SELECT ok(NOT has_table_privilege('anon', 'public.alert_triggers', 'select'), 'anon has no SELECT on alert_triggers');
SELECT ok(NOT has_table_privilege('authenticated', 'public.alert_rules', 'select'), 'authenticated has no SELECT on alert_rules');
SELECT ok(NOT has_table_privilege('authenticated', 'public.alert_triggers', 'select'), 'authenticated has no SELECT on alert_triggers');

SELECT finish();

ROLLBACK;
