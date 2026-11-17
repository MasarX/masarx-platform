-- Migration: Weekly partition catchup for webhook_log and api_call_log
-- Purpose: Ensure weekly tables honor partitions_ahead settings (create missing future partitions).

BEGIN;

SELECT * FROM public.create_next_partitions();

COMMIT;
