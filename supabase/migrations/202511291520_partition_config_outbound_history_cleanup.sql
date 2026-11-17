-- Migration: partitioning_config cleanup for removed outbound_history table
-- Purpose:
--   Align partitioning_config with the current schema by removing the
--   outbound_history entry (table was superseded by outbound_calls).

BEGIN;

DELETE FROM public.partitioning_config
 WHERE table_name = 'outbound_history';

COMMIT;

