-- Migration: Onboarding readiness Mobile V2 late policy defaults
-- Purpose: Materialize Mobile V2 policy defaults added after the previous
-- onboarding readiness backfill for existing real tenant organizations.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605300030_onboarding_readiness_mobile_v2_late_policy_defaults_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '60s';

DO $$
DECLARE
  v_org RECORD;
  v_policy JSONB := public.resolve_saas_onboarding_policy_v1();
BEGIN
  FOR v_org IN
    SELECT o.id
    FROM public.organizations o
    WHERE o.id <> '00000000-0000-0000-0000-000000000000'::uuid
    ORDER BY o.id
  LOOP
    PERFORM public.bootstrap_scope_settings_defaults_v1(
      'tenant',
      v_org.id,
      v_policy,
      'console-v2:mobile-v2-late-policy-defaults-backfill'
    );
  END LOOP;
END $$;

SELECT pg_advisory_unlock(hashtext('202605300030_onboarding_readiness_mobile_v2_late_policy_defaults_v1'));

COMMIT;
