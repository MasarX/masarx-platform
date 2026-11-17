-- Plan: PLAN-202602-integration-plugin-studio-v1 / Step: S99
-- Migration: integration plugin FK index redundancy repair v1
-- Purpose:
--   - Resolve exact duplicate index groups detected by pgTAP `0zz_index_redundancy.sql`
--     for integration plugin control-plane FK columns.
--   - Drop only redundant indexes that have an exact equivalent peer index on the same table.
-- Safety:
--   - Fail-safe: an index is dropped only when an exact duplicate peer exists.

BEGIN;
SELECT pg_advisory_lock(hashtext('202602220140_integration_plugin_fk_index_redundancy_repair_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $$
DECLARE
  rec RECORD;
BEGIN
  FOR rec IN
    WITH target AS (
      SELECT
        n.nspname AS schema_name,
        c.relname AS index_name,
        c.oid AS index_oid,
        i.indrelid,
        i.indkey,
        i.indoption,
        i.indpred,
        i.indexprs,
        COALESCE(i.indnullsnotdistinct, FALSE) AS indnullsnotdistinct
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      JOIN pg_index i ON i.indexrelid = c.oid
      WHERE n.nspname = 'public'
        AND c.relkind = 'i'
        AND c.relname = ANY (ARRAY[
          'idx_integration_plugins_active_version_id',
          'idx_integration_plugins_base_plugin_id',
          'idx_integration_plugins_created_by',
          'idx_integration_plugins_updated_by',
          'idx_integration_plugin_versions_created_by',
          'idx_integration_plugin_versions_updated_by',
          'idx_integration_plugin_versions_submitted_by',
          'idx_integration_plugin_versions_approved_by',
          'idx_integration_plugin_versions_activated_by',
          'idx_integration_plugin_bindings_created_by',
          'idx_integration_plugin_validation_runs_executed_by',
          'idx_integration_plugin_approval_events_actor_user_id'
        ]::TEXT[])
    )
    SELECT t.schema_name, t.index_name
    FROM target t
    WHERE EXISTS (
      SELECT 1
      FROM pg_index p
      JOIN pg_class c2 ON c2.oid = p.indexrelid
      JOIN pg_namespace n2 ON n2.oid = c2.relnamespace
      WHERE p.indrelid = t.indrelid
        AND p.indexrelid <> t.index_oid
        AND p.indkey = t.indkey
        AND p.indoption = t.indoption
        AND p.indpred IS NOT DISTINCT FROM t.indpred
        AND p.indexprs IS NOT DISTINCT FROM t.indexprs
        AND COALESCE(p.indnullsnotdistinct, FALSE) = t.indnullsnotdistinct
        AND n2.nspname = t.schema_name
    )
    ORDER BY t.schema_name, t.index_name
  LOOP
    EXECUTE format('DROP INDEX IF EXISTS %I.%I', rec.schema_name, rec.index_name);
  END LOOP;
END;
$$;

SELECT pg_advisory_unlock(hashtext('202602220140_integration_plugin_fk_index_redundancy_repair_v1'));
COMMIT;
