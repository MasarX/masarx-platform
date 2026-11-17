-- Migration: shipments tracking_upper and unique index by client
-- Purpose: Enforce case-insensitive uniqueness of tracking_number per client

BEGIN;

-- Add generated uppercase column for case-insensitive comparison
ALTER TABLE shipments
  ADD COLUMN IF NOT EXISTS tracking_upper text GENERATED ALWAYS AS (upper(tracking_number)) STORED;

-- Unique index per client scope (parent is partitioned by client_id)
-- Including partition key (client_id) makes the unique constraint valid on partitioned tables
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shipments_client_tracking_upper
  ON shipments (client_id, tracking_upper)
  WHERE tracking_number IS NOT NULL;

COMMIT;

