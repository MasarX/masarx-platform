-- Migration: Disable dialog360 mock mode by default
-- Purpose:
--   - Production hardening: do not rely on provider metadata mock flags for core behavior.
--   - Live tests are gated by RUN_LIVE_COMMS_TESTS (see verify:cloud:live); core verify should not depend on mocks.
-- Date: 2025-12-14

BEGIN;

UPDATE public.providers
SET metadata = jsonb_strip_nulls(COALESCE(metadata, '{}'::jsonb) - 'mock' - 'mock_reason'),
    updated_at = now()
WHERE name = 'dialog360_whatsapp'
  AND (COALESCE(metadata, '{}'::jsonb) ? 'mock' OR COALESCE(metadata, '{}'::jsonb) ? 'mock_reason');

COMMIT;

