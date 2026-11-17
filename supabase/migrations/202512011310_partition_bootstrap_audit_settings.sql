-- Migration: Bootstrap partitions for new audit/settings provenance tables
-- Date: 2025-12-01 13:10 UTC

BEGIN;

DO $$
BEGIN
  PERFORM public.create_next_partitions();
  PERFORM public.apply_partition_index_templates();
END;
$$;

COMMIT;
