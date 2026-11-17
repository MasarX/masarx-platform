-- Migration: security_rls_user_facing view
-- Purpose: Provide a curated, data-defined list of user-facing tables for generic RLS enforcement tests.
-- Notes: Keep additive and idempotent; update this view via follow-up migrations as the contract evolves.

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

