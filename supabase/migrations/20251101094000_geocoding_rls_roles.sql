-- Phase 2 – Geocoding RLS and Role Compliance
-- Enables RLS on geocoding tables, defines worker/manual roles, and introduces
-- SECURITY DEFINER guards for future geocoding helper functions.

BEGIN;

SELECT pg_advisory_lock(hashtext('20251101094000_geocoding_rls_roles'));

SET search_path TO public;

-- Enable RLS on geocodes and geocoding_attempts.
ALTER TABLE IF EXISTS public.geocodes ENABLE ROW LEVEL SECURITY;
ALTER TABLE IF EXISTS public.geocoding_attempts ENABLE ROW LEVEL SECURITY;

-- Replace tenant-scoped policies (authenticated users limited by organization).
DROP POLICY IF EXISTS geocodes_rls_policy ON public.geocodes;
CREATE POLICY geocodes_rls_policy ON public.geocodes
    FOR ALL
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

DROP POLICY IF EXISTS geocoding_attempts_rls_policy ON public.geocoding_attempts;
CREATE POLICY geocoding_attempts_rls_policy ON public.geocoding_attempts
    FOR ALL
    TO authenticated
    USING (organization_id = current_user_org_id())
    WITH CHECK (organization_id = current_user_org_id());

COMMENT ON POLICY geocodes_rls_policy ON public.geocodes IS 'Authenticated users limited to rows for their organization.';
COMMENT ON POLICY geocoding_attempts_rls_policy ON public.geocoding_attempts IS 'Authenticated users limited to rows for their organization.';

-- Helper to ensure service-role execution for worker routines.
CREATE OR REPLACE FUNCTION public.geocoding_assert_service_role()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_claims jsonb;
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', true);

    BEGIN
        v_claims := current_setting('request.jwt.claims', true)::jsonb;
    EXCEPTION
        WHEN others THEN
            v_claims := NULL;
    END;

    IF current_user NOT IN ('service_role', 'postgres', 'supabase_admin') THEN
        IF v_claims IS NULL OR v_claims->>'role' IS DISTINCT FROM 'service_role' THEN
            RAISE EXCEPTION 'geocoding worker helpers require service role context.';
        END IF;
    END IF;
END;
$$;

COMMENT ON FUNCTION public.geocoding_assert_service_role IS 'Guards SECURITY DEFINER geocoding worker routines to service-role callers.';

-- Helper to ensure manual review role membership.
CREATE OR REPLACE FUNCTION public.geocoding_assert_manual_role()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
    PERFORM set_config('search_path', 'public, pg_temp', true);

    IF NOT has_role(current_user, 'geocoding_manual_role', 'member') THEN
        RAISE EXCEPTION 'geocoding manual review helpers require geocoding_manual_role membership.';
    END IF;
END;
$$;

COMMENT ON FUNCTION public.geocoding_assert_manual_role IS 'Ensures manual review routines execute under geocoding_manual_role membership.';

-- Create dedicated roles if missing.
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geocoding_worker_role') THEN
        CREATE ROLE geocoding_worker_role NOLOGIN;
        COMMENT ON ROLE geocoding_worker_role IS 'Least-privilege role for automated geocoding workers.';
    END IF;

    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'geocoding_manual_role') THEN
        CREATE ROLE geocoding_manual_role NOLOGIN;
        COMMENT ON ROLE geocoding_manual_role IS 'Role for human reviewers handling manual geocoding tasks.';
    END IF;
END
$$;

-- Grant roles to appropriate principals.
GRANT geocoding_worker_role TO service_role;

-- Table privileges for worker/manual roles.
GRANT SELECT, INSERT, UPDATE ON public.geocoding_attempts TO geocoding_worker_role;
GRANT SELECT, INSERT, UPDATE ON public.geocodes TO geocoding_worker_role;
GRANT SELECT ON public.addresses TO geocoding_worker_role;
GRANT SELECT ON public.providers TO geocoding_worker_role;
GRANT SELECT ON public.settings_versions TO geocoding_worker_role;
GRANT SELECT ON public.settings TO geocoding_worker_role;

GRANT SELECT ON public.geocoding_attempts TO geocoding_manual_role;
GRANT SELECT ON public.geocodes TO geocoding_manual_role;

SELECT pg_advisory_unlock(hashtext('20251101094000_geocoding_rls_roles'));

COMMIT;
