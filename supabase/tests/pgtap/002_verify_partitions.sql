-- Test file: 002_verify_partitions.sql
-- Purpose: Verify dynamic partition contracts for current HASH and HASH+RANGE topology.
-- Notes:
-- - Avoid hardcoded time windows and suffix variants that drift with retention.
-- - Enforce stable parent/hash partition shape and dynamic range coverage.

BEGIN;

SELECT plan(17);

-- Stable HASH partitions.
SELECT has_table('settings_versions_p0', 'settings_versions HASH partition p0 exists');
SELECT has_table('decision_log_p0', 'decision_log HASH partition p0 exists');
SELECT has_table('webhook_log_p0', 'webhook_log HASH partition p0 exists');
SELECT has_table('api_call_log_p0', 'api_call_log HASH partition p0 exists');
SELECT has_table('addresses_p0', 'addresses HASH partition p0 exists');
SELECT has_table('geocodes_p0', 'geocodes HASH partition p0 exists');
SELECT has_table('geocodes_p1', 'geocodes HASH partition p1 exists');
SELECT has_table('geocodes_p2', 'geocodes HASH partition p2 exists');
SELECT has_table('geocodes_p3', 'geocodes HASH partition p3 exists');
SELECT has_table('labels_p0', 'labels HASH partition p0 exists');
SELECT has_table('shipments_p0', 'shipments HASH partition p0 exists');

-- Dynamic RANGE children under HASH+RANGE parents.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'decision_log_p0'
  ),
  'decision_log_p0 has RANGE child partitions'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'webhook_log_p0'
  ),
  'webhook_log_p0 has RANGE child partitions'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'api_call_log_p0'
  ),
  'api_call_log_p0 has RANGE child partitions'
);

-- Dynamic future coverage from partition inventory.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.partition_inventory pi
    WHERE pi.table_name = 'decision_log'
      AND pi.partition_strategy = 'HASH+RANGE'
      AND pi.end_at > now()
  ),
  'decision_log has future HASH+RANGE partition coverage'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.partition_inventory pi
    WHERE pi.table_name = 'webhook_log'
      AND pi.partition_strategy = 'HASH+RANGE'
      AND pi.end_at > now()
  ),
  'webhook_log has future HASH+RANGE partition coverage'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM public.partition_inventory pi
    WHERE pi.table_name = 'api_call_log'
      AND pi.partition_strategy = 'HASH+RANGE'
      AND pi.end_at > now()
  ),
  'api_call_log has future HASH+RANGE partition coverage'
);

SELECT * FROM finish();

ROLLBACK;
