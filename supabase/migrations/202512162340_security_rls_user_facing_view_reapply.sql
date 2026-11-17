-- Migration: Reapply security_rls_user_facing view (drift fix)
-- Purpose: Ensure pgTAP generic RLS enforcement uses the curated SSOT list (prevents drift from expanding the candidate set).
-- Alignment: SIMPLE - SCALABLE - DYNAMIC - workflow/row-driven - ZERO HARD CODING.
-- Date: 2025-12-16

BEGIN;

SET search_path TO public, pg_temp;

CREATE OR REPLACE VIEW public.security_rls_user_facing AS
SELECT unnest(
  ARRAY[
    'organizations',
    'clients',
    'senders',
    'providers',
    'webhook_sources',
    'shipments',
    'recipients',
    'addresses',
    'geocoding_attempts',
    'geocodes'
  ]::text[]
) AS tablename;

COMMENT ON VIEW public.security_rls_user_facing IS
  'Curated list of user-facing tables that must have RLS enabled (used by pgTAP generic RLS enforcement).';

COMMIT;

