-- Plan: PLAN-202512-shipment-references-ssot / Step: S01
-- Migration: Enforce shipments client reference uniqueness
-- Purpose:
--   - Add a normalized generated column for client_reference_number.
--   - Enforce per-client uniqueness (case/whitespace-insensitive) to prevent
--     accidental duplicate shipment creation by business key.
-- Date: 2025-12-29

BEGIN;

-- Normalized (trimmed, uppercased) client reference.
ALTER TABLE public.shipments
  ADD COLUMN IF NOT EXISTS client_reference_upper TEXT
    GENERATED ALWAYS AS (upper(NULLIF(btrim(client_reference_number), ''))) STORED;

-- Preflight query (prod safety): detect duplicates before enabling uniqueness.
-- SELECT
--   client_id,
--   upper(NULLIF(btrim(client_reference_number), '')) AS client_reference_upper,
--   COUNT(*) AS cnt
-- FROM public.shipments
-- WHERE upper(NULLIF(btrim(client_reference_number), '')) IS NOT NULL
-- GROUP BY 1, 2
-- HAVING COUNT(*) > 1;

CREATE UNIQUE INDEX IF NOT EXISTS uniq_shipments_client_client_reference_upper
  ON public.shipments (client_id, client_reference_upper)
  WHERE client_reference_upper IS NOT NULL;

COMMENT ON COLUMN public.shipments.client_reference_upper
  IS 'Normalized (trimmed, uppercased) client_reference_number for case-insensitive uniqueness per client.';

COMMIT;

