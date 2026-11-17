-- Migration: support_cases client_id FK index fixup v1
-- Purpose:
--   - pgTAP `0zz_fk_index_hygiene.sql` enforces that all foreign keys have supporting
--     non-partial indexes on referencing columns.
--   - `support_cases.client_id` is NOT NULL; a partial index is redundant and does not
--     satisfy the non-partial requirement.

BEGIN;

SELECT pg_advisory_lock(hashtext('202601311800_support_cases_client_fk_index_fixup_v1'));

-- Replace redundant partial index with a full (non-partial) index.
DROP INDEX IF EXISTS public.idx_support_cases_client_status;
CREATE INDEX IF NOT EXISTS idx_support_cases_client_status
  ON public.support_cases (client_id, status, created_at DESC);

SELECT pg_advisory_unlock(hashtext('202601311800_support_cases_client_fk_index_fixup_v1'));

COMMIT;

