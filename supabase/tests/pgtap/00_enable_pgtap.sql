-- Enable pgTAP extension for testing
-- This file should be run before other tests
-- Task: 6.1 - Setup pgTAP extension

-- Enable pgTAP extension (required for test framework)
CREATE EXTENSION IF NOT EXISTS pgtap SCHEMA extensions;

-- Note: Supabase local development includes pgTAP by default
-- This command ensures it's enabled in the extensions schema
-- Tests can now use pgTAP functions like plan(), has_table(), has_index(), etc.

-- Simple assertion so pgTAP runner records a passing test.
SELECT plan(1);
SELECT ok(true, 'pgTAP extension enabled and ready');
SELECT * FROM finish();
