-- Migration: doc_url coverage for geo_short_code_registry handler
-- Purpose:
--   Ensure operation_handlers.doc_url is set for the geo_short_code_registry handler so pgTAP
--   doc coverage passes and operator docs remain discoverable.
-- Alignment: SSOT docs, zero hardcoding (stable doc path), best practice.
-- Date: 2025-12-26

BEGIN;

SET search_path TO public, extensions, pg_temp;

UPDATE public.operation_handlers
SET doc_url = 'docs/ops/runbooks/geocoding_worker.md',
    updated_at = now()
WHERE handler_key = 'geo_short_code_registry'
  AND is_active
  AND (doc_url IS NULL OR length(trim(doc_url)) = 0);

COMMIT;

