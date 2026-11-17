-- Test: Trace + audit hardening

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

-- Audit ledger exists with RLS and indexes
SELECT has_table('public','audit_table_changes','audit_table_changes table exists');
SELECT ok((SELECT rowsecurity FROM pg_tables WHERE schemaname='public' AND tablename='audit_table_changes'), 'RLS enabled on audit_table_changes');
SELECT has_index('public','audit_table_changes_p0','idx_audit_table_changes_org_created','org+created index present');
SELECT has_table('public','table_contracts','table_contracts exists');
SELECT has_trigger('public','shipments','audit_row_change','shipments audit trigger present');
SELECT has_trigger('public','ops_alerts','audit_row_change','ops_alerts audit trigger present');
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger tg
    WHERE tg.tgrelid = 'public.decision_log'::regclass
      AND tg.tgname = 'audit_row_change'
  ),
  'decision_log audit trigger absent (audit disabled by contract)'
);
SELECT ok(
  NOT EXISTS (
    SELECT 1
    FROM pg_catalog.pg_trigger tg
    WHERE tg.tgrelid = 'public.provider_health_logs'::regclass
      AND tg.tgname = 'audit_row_change'
  ),
  'provider_health_logs audit trigger absent (audit disabled by contract)'
);

-- Trace-aware api_call_log
SELECT has_column('public','api_call_log','correlation_id','api_call_log has correlation_id');
SELECT has_index('public','api_call_log','idx_api_call_log_correlation','api_call_log correlation_id index present');

-- Observability view present
SELECT has_view('public','observability_events_v','observability_events_v present');

SELECT finish();

ROLLBACK;
