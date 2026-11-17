-- Plan: PLAN-202601-ladder-phase2-scope-from-context / Step: S04
-- Migration: RBAC fixup - commercial agreements SELECT gate (v1)
-- Purpose:
--   - Re-assert least-privilege tenant reads for commercial_agreements and commercial_agreement_terms.
--   - Some long-lived preview projects can drift to the pre-RBAC select policy; this fixup ensures
--     authenticated SELECT requires agreements.read (platform + service bypass preserved).

BEGIN;
SELECT pg_advisory_lock(hashtext('202602041030_rbac_commercial_agreements_select_gate_fixup_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP POLICY IF EXISTS commercial_agreements_select ON public.commercial_agreements;
CREATE POLICY commercial_agreements_select ON public.commercial_agreements
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('agreements.read', organization_id)
    )
  );

DROP POLICY IF EXISTS commercial_agreement_terms_select ON public.commercial_agreement_terms;
CREATE POLICY commercial_agreement_terms_select ON public.commercial_agreement_terms
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      public.current_user_scope_type() = 'tenant'
      AND EXISTS (
        SELECT 1
        FROM public.commercial_agreements a
        WHERE a.id = commercial_agreement_terms.agreement_id
          AND a.organization_id = public.current_user_org_id()
          AND public.user_has_permission_v1('agreements.read', a.organization_id)
      )
    )
  );

SELECT pg_advisory_unlock(hashtext('202602041030_rbac_commercial_agreements_select_gate_fixup_v1'));
COMMIT;

