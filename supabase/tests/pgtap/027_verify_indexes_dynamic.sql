-- Test file: 027_verify_indexes_dynamic.sql
-- Purpose: Verify critical indexes exist without relying on time-bound partition names

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

-- Plan: 5 checks
SELECT plan(5);

-- Shipments p0 primary key
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shipments_p0'
      AND indexname = 'shipments_p0_pkey'
  ),
  'Shipments p0 has primary key index'
);

-- Shipments tracking unique (implementation-specific name used in current schema)
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'shipments_p0'
      AND indexname = 'shipments_p0_tracking_number_client_id_key'
  ),
  'Shipments p0 has tracking_number+client_id unique index'
);

-- Labels p0 primary key
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'labels_p0'
      AND indexname = 'labels_p0_pkey'
  ),
  'Labels p0 has primary key index'
);

-- Addresses p0 primary key
SELECT ok(
  EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE schemaname = 'public'
      AND tablename = 'addresses_p0'
      AND indexname = 'addresses_p0_pkey'
  ),
  'Addresses p0 has primary key index'
);

-- Decision log RANGE partition primary key exists for at least one RANGE child
SELECT ok(
  EXISTS (
    SELECT 1
    FROM pg_indexes idx
    JOIN pg_class rel ON rel.relname = idx.tablename
    WHERE idx.schemaname = 'public'
      AND rel.relname LIKE 'decision_log_%_%'  -- decision_log_YYYY_MM
      AND idx.indexname = rel.relname || '_pkey'
  ),
  'Decision log has pkey on at least one RANGE partition'
);

SELECT finish();

ROLLBACK;

