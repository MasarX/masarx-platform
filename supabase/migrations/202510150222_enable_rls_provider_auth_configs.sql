-- Migration: Enable RLS on provider_auth_configs
-- Purpose: Protect provider credentials by enforcing role-based access

BEGIN;

ALTER TABLE provider_auth_configs ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE provider_auth_configs FROM anon;
REVOKE ALL ON TABLE provider_auth_configs FROM authenticated;

DROP POLICY IF EXISTS provider_auth_configs_service_role ON provider_auth_configs;

CREATE POLICY provider_auth_configs_service_role
    ON provider_auth_configs
    FOR ALL
    TO service_role
    USING (true)
    WITH CHECK (true);

COMMIT;
