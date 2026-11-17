-- Migration: Align partitioning_config for geocodes partition key
-- Purpose: Ensure partitioning_config reflects actual geocodes table partitioning by address_id
-- Date: 2025-11-23 14:00

BEGIN;

-- Update geocodes partition key to match actual table definition
UPDATE partitioning_config
SET partition_key = 'address_id'
WHERE table_name = 'geocodes'
  AND partition_strategy IN ('HASH','HASH+RANGE')
  AND partition_key IS DISTINCT FROM 'address_id';

COMMIT;

