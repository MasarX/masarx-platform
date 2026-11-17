-- Migration: Align shipment_boxes partitioning_config with non-partitioned table
-- Purpose: shipment_boxes is intentionally non-partitioned (see 202510110006_domain_tables_partitioned.sql).
--          Ensure partitioning_config reflects NONE so integrity tests pass.

BEGIN;

UPDATE partitioning_config
SET partition_strategy = 'NONE',
    partition_interval = NULL,
    partitions_ahead = NULL,
    retention_months = NULL,
    config = NULL,
    updated_at = now()
WHERE table_name = 'shipment_boxes'
  AND partition_strategy <> 'NONE';

COMMIT;
