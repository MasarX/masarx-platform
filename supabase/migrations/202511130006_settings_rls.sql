-- Migration: RLS on settings tables
-- Purpose: Enforce RLS on settings and settings_versions with service_role-only access
-- Date: 2025-11-13

BEGIN;

-- settings
ALTER TABLE public.settings ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settings FROM PUBLIC;
REVOKE ALL ON TABLE public.settings FROM anon;
REVOKE ALL ON TABLE public.settings FROM authenticated;

DROP POLICY IF EXISTS settings_service_policy ON public.settings;
CREATE POLICY settings_service_policy
  ON public.settings
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

-- settings_versions (partitioned)
ALTER TABLE public.settings_versions ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.settings_versions FROM PUBLIC;
REVOKE ALL ON TABLE public.settings_versions FROM anon;
REVOKE ALL ON TABLE public.settings_versions FROM authenticated;

DROP POLICY IF EXISTS settings_versions_service_policy ON public.settings_versions;
CREATE POLICY settings_versions_service_policy
  ON public.settings_versions
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

COMMIT;

