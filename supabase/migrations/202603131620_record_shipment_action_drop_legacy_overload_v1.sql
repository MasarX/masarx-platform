BEGIN;

-- Remove the legacy 8-argument overload now that the 9-argument variant
-- provides the same call surface with a default timestamp. Keeping both
-- signatures makes 8-argument callers ambiguous under lint and runtime
-- revalidation.
DROP FUNCTION IF EXISTS workflow_handlers.record_shipment_action_v1(
  UUID,
  TEXT,
  TEXT,
  JSONB,
  TEXT,
  TEXT,
  TEXT,
  UUID
);

COMMIT;
