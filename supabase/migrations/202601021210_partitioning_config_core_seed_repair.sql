-- Migration: Repair baseline partitioning_config seed rows (drift-safe)
-- Purpose:
-- - Some cloud/preview environments can drift where seed/alignment migrations are marked
--   applied without the intended DML (or rows were deleted later).
-- - Core integration tests expect these rows to exist with the correct strategies.
-- - This migration repairs the canonical SSOT configuration without hardcoding tenant/client data.
-- Notes:
-- - DML-only, safe + idempotent (UPSERT).
-- - Also re-applies the *final* intended keys (e.g., geocodes=address_id, settings_versions=scope_hash)
--   so later key-fix migrations don't get skipped by drift.

BEGIN;

DO $$
BEGIN
  IF to_regclass('public.partitioning_config') IS NULL THEN
    RAISE NOTICE 'Skipping partitioning_config seed repair (partitioning_config missing)';
    RETURN;
  END IF;

  -- HASH parents (domain + configuration)
  IF to_regclass('public.shipments') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'shipments',
      'HASH',
      'client_id',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.addresses') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'addresses',
      'HASH',
      'client_id',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.geocodes') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'geocodes',
      'HASH',
      'address_id',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 4, 'expandable_to', jsonb_build_array(16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.labels') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'labels',
      'HASH',
      'shipment_id',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.shipment_boxes') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'shipment_boxes',
      'HASH',
      'shipment_id',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.settings_versions') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'settings_versions',
      'HASH',
      'scope_hash',
      NULL,
      NULL,
      NULL,
      jsonb_build_object('modulus', 1, 'expandable_to', jsonb_build_array(4, 16))
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  -- HASH+RANGE log parents (window + retention driven by partition_defaults + per-table config)
  IF to_regclass('public.api_call_log') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'api_call_log',
      'HASH+RANGE',
      'organization_id|timestamp',
      'weekly',
      NULL,
      6,
      jsonb_build_object(
        'hash_modulus', 1,
        'range_interval', 'weekly',
        'retention_policy', 'archive'
      )
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.decision_log') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'decision_log',
      'HASH+RANGE',
      'organization_id|timestamp',
      'monthly',
      NULL,
      12,
      jsonb_build_object(
        'hash_modulus', 1,
        'range_interval', 'monthly',
        'retention_policy', 'archive'
      )
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;

  IF to_regclass('public.webhook_log') IS NOT NULL THEN
    INSERT INTO public.partitioning_config (
      table_name,
      partition_strategy,
      partition_key,
      partition_interval,
      partitions_ahead,
      retention_months,
      config
    )
    VALUES (
      'webhook_log',
      'HASH+RANGE',
      'organization_id|timestamp',
      'weekly',
      NULL,
      6,
      jsonb_build_object(
        'hash_modulus', 1,
        'range_interval', 'weekly',
        'retention_policy', 'archive'
      )
    )
    ON CONFLICT (table_name) DO UPDATE
    SET partition_strategy = EXCLUDED.partition_strategy,
        partition_key = EXCLUDED.partition_key,
        partition_interval = EXCLUDED.partition_interval,
        partitions_ahead = EXCLUDED.partitions_ahead,
        retention_months = EXCLUDED.retention_months,
        config = EXCLUDED.config,
        updated_at = now();
  END IF;
END $$;

COMMIT;

