-- Migration: rls_coverage_clients_select_grant
-- Purpose: Ensure authenticated users can SELECT from clients under RLS,
--          so RLS isolation policies that reference clients do not raise
--          permission errors for coverage tests.

BEGIN;

GRANT SELECT ON clients TO authenticated;

COMMIT;

