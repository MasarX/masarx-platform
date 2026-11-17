-- Test file: 004_verify_indexes.sql
-- Purpose: Verify critical index contracts without hardcoded time-bound partitions.

BEGIN;

SELECT plan(15);

-- Shipments critical indexes.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shipments_p0'
      AND indexname = 'shipments_p0_tracking_number_client_id_key'
  ),
  'shipments_p0 has unique tracking_number+client_id index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shipments_p0'
      AND indexname = 'shipments_p0_pkey'
  ),
  'shipments_p0 has primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shipments_p0'
      AND indexname = 'idx_shipments_p0_tracking'
  ),
  'shipments_p0 has tracking lookup index'
);

-- Geocodes hash partitions must each keep a primary key index.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'geocodes_p0'
      AND indexname = 'geocodes_p0_pkey'
  ),
  'geocodes_p0 has primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'geocodes_p1'
      AND indexname = 'geocodes_p1_pkey'
  ),
  'geocodes_p1 has primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'geocodes_p2'
      AND indexname = 'geocodes_p2_pkey'
  ),
  'geocodes_p2 has primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'geocodes_p3'
      AND indexname = 'geocodes_p3_pkey'
  ),
  'geocodes_p3 has primary key index'
);

-- Decision log hash parent and active range children.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'decision_log_p0'
      AND indexname = 'decision_log_p0_pkey'
  ),
  'decision_log_p0 has hash-partition primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_indexes idx
      ON idx.schemaname = cn.nspname
     AND idx.tablename = child.relname
     AND idx.indexname = child.relname || '_pkey'
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'decision_log_p0'
  ),
  'decision_log_p0 has at least one range child with primary key index'
);

-- Webhook log hash parent and active range children.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'webhook_log_p0'
      AND indexname = 'webhook_log_p0_pkey'
  ),
  'webhook_log_p0 has hash-partition primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_indexes idx
      ON idx.schemaname = cn.nspname
     AND idx.tablename = child.relname
     AND idx.indexname = child.relname || '_pkey'
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'webhook_log_p0'
  ),
  'webhook_log_p0 has at least one range child with primary key index'
);

-- API call log hash parent and active range children.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'api_call_log_p0'
      AND indexname = 'api_call_log_p0_pkey'
  ),
  'api_call_log_p0 has hash-partition primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_inherits i
    JOIN pg_class parent ON parent.oid = i.inhparent
    JOIN pg_namespace pn ON pn.oid = parent.relnamespace
    JOIN pg_class child ON child.oid = i.inhrelid
    JOIN pg_namespace cn ON cn.oid = child.relnamespace
    JOIN pg_indexes idx
      ON idx.schemaname = cn.nspname
     AND idx.tablename = child.relname
     AND idx.indexname = child.relname || '_pkey'
    WHERE pn.nspname = 'public'
      AND cn.nspname = 'public'
      AND parent.relname = 'api_call_log_p0'
  ),
  'api_call_log_p0 has at least one range child with primary key index'
);

-- Additional critical business tables.
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'labels_p0'
      AND indexname = 'labels_p0_pkey'
  ),
  'labels_p0 has primary key index'
);

SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'addresses_p0'
      AND indexname = 'addresses_p0_pkey'
  ),
  'addresses_p0 has primary key index'
);

SELECT * FROM finish();

ROLLBACK;
