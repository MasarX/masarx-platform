-- Plan: PLAN-202601-address-versioned-addresses-pitch-progress / Step: S06
-- Migration: doc_url coverage for geo_ai_extract handler
-- Purpose:
--   Ensure operation_handlers.doc_url is set for the geo_ai_extract handler so pgTAP
--   documentation coverage checks pass.
-- Alignment: No behavior change; metadata backfill only.
-- Date: 2026-01-06

BEGIN;

UPDATE public.operation_handlers
SET doc_url = 'docs/ops/runbooks/geocoding_worker.md'
WHERE handler_key = 'geo_ai_extract'
  AND handler_version = 'v1'
  AND (doc_url IS NULL OR length(trim(doc_url)) = 0);

COMMIT;
