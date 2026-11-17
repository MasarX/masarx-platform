-- Test file: 003_verify_rls_policies.sql
-- Purpose: Verify Row-Level Security (RLS) is enabled on all required tables
-- Task: 6.4 - Create RLS verification test
-- FIXED: Uses direct pg_tables query instead of pgTAP functions
-- Schema Reference: Plan.md Section 4 + actual RLS implementation

BEGIN;

-- Declare test plan: 10 RLS policy checks (per backend-verification.md)
SELECT plan(12);

-- =============================================================================
-- SECTION 1: Verify RLS Enabled on Tables
-- =============================================================================
-- These tables require RLS for multi-tenant data isolation
-- Checking rowsecurity column in pg_tables instead of using pgTAP functions
-- =============================================================================

-- Test 1: shipments table (client_id isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'shipments'),
    'RLS should be enabled on shipments table for multi-tenant isolation by client_id'
);

-- Test 2: addresses table (client_id isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'addresses'),
    'RLS should be enabled on addresses table for multi-tenant isolation by client_id'
);

-- Test 3: recipients table (client_id isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'recipients'),
    'RLS should be enabled on recipients table for multi-tenant isolation by client_id'
);

-- Test 4: organizations table (tenant isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'organizations'),
    'RLS should be enabled on organizations table for tenant isolation'
);

-- Test 5: clients table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'clients'),
    'RLS should be enabled on clients table for organization isolation'
);

-- Test 6: senders table (client isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'senders'),
    'RLS should be enabled on senders table for client isolation'
);

-- Test 7: providers table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'providers'),
    'RLS should be enabled on providers table for organization isolation'
);

-- Test 8: webhook_sources table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'webhook_sources'),
    'RLS should be enabled on webhook_sources table for organization isolation'
);

-- Test 9: geocoding_attempts table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'geocoding_attempts'),
    'RLS should be enabled on geocoding_attempts table for organization isolation'
);

-- Test 10: geocodes table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'geocodes'),
    'RLS should be enabled on geocodes table for organization isolation'
);

-- Test 11: canonical_cities table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'canonical_cities'),
    'RLS should be enabled on canonical_cities table for organization isolation'
);

-- Test 12: canonical_districts table (organization isolation)
SELECT ok(
    (SELECT rowsecurity FROM pg_tables WHERE schemaname = 'public' AND tablename = 'canonical_districts'),
    'RLS should be enabled on canonical_districts table for organization isolation'
);

-- =============================================================================
-- Finish Tests
-- =============================================================================

SELECT * FROM finish();

ROLLBACK;

-- =============================================================================
-- Test Summary - ACTUAL IMPLEMENTATION
-- =============================================================================
--
-- Total RLS Policies Verified: 12 (per backend-verification.md finding)
--
-- RLS Enabled Tables (actual implementation):
--   1. organizations - tenant isolation
--   2. clients - organization isolation
--   3. senders - client isolation
--   4. providers - organization isolation
--   5. webhook_sources - organization isolation
--   6. shipments - client_id isolation
--   7. recipients - client_id isolation
--   8. addresses - client_id isolation
--   9. geocoding_attempts - organization isolation
--  10. geocodes - organization isolation
--  11. canonical_cities - organization isolation
--  12. canonical_districts - organization isolation
--
-- VERIFICATION METHOD:
--   Using direct pg_tables query: SELECT rowsecurity FROM pg_tables
--   This is more reliable than pgTAP functions that may have type casting issues
--
-- Isolation Strategy:
--   - Tenant level: organizations
--   - Organization level: clients, providers, webhook_sources
--   - Client level: senders, shipments, recipients, addresses
--
-- Success Criteria:
--   - All 12 tables have RLS enabled (rowsecurity = true)
--   - Tests complete in < 10 seconds
--   - Matches actual implementation
--
