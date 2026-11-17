-- Test: Logging RLS and privacy contracts

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(10);

-- Parents must have RLS enabled
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='decision_log'), 'RLS enabled on decision_log');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='webhook_log'), 'RLS enabled on webhook_log');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='api_call_log'), 'RLS enabled on api_call_log');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='settings_resolution_log'), 'RLS enabled on settings_resolution_log');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='audit_table_changes'), 'RLS enabled on audit_table_changes');

-- Policies exist (service_role / scoped)
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='decision_log'), 'decision_log has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='webhook_log'), 'webhook_log has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='api_call_log'), 'api_call_log has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='settings_resolution_log'), 'settings_resolution_log has policies');
SELECT ok(EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='public' AND tablename='audit_table_changes'), 'audit_table_changes has policies');

SELECT finish();

ROLLBACK;
