-- Plan: PLAN-202601-last-mile-enterprise-audit / Step: S04
-- Migration: RBAC rollout v1 - gate sensitive tenant reads via permissions (additive, minimal)
-- Date: 2026-01-30
--
-- Goals:
--   - Begin least-privilege rollout without breaking service workflows.
--   - Gate sensitive tenant-visible reads behind RBAC predicates (finance/agreements).
--   - Preserve platform/service bypasses and org isolation.

BEGIN;
SELECT pg_advisory_lock(hashtext('202601300060_rbac_sensitive_table_select_gates_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) bank_accounts: require finance.read for authenticated SELECT
-------------------------------------------------------------------------------

DROP POLICY IF EXISTS bank_accounts_authenticated_select ON public.bank_accounts;
CREATE POLICY bank_accounts_authenticated_select
  ON public.bank_accounts
  FOR SELECT
  TO authenticated
  USING (
    public.is_platform_user()
    OR (
      organization_id = public.current_user_org_id()
      AND public.user_has_permission_v1('finance.read', organization_id)
    )
  );

UPDATE public.table_contracts
   SET notes = 'Tenant bank accounts (non-sensitive fields only). Authenticated can SELECT when RBAC permits (finance.read); writes are service-only.'
 WHERE table_schema = 'public' AND table_name = 'bank_accounts';

-------------------------------------------------------------------------------
-- 2) commercial agreements: require agreements.read for authenticated SELECT
-------------------------------------------------------------------------------

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

UPDATE public.table_contracts
   SET notes = 'Governance-only agreements registry; audit enabled. Tenant reads require RBAC (agreements.read); writes are service-only.'
 WHERE table_schema = 'public' AND table_name = 'commercial_agreements';

UPDATE public.table_contracts
   SET notes = 'Agreement baseline settings references; audit enabled. Tenant reads require RBAC (agreements.read); writes are service-only.'
 WHERE table_schema = 'public' AND table_name = 'commercial_agreement_terms';

SELECT pg_advisory_unlock(hashtext('202601300060_rbac_sensitive_table_select_gates_v1'));
COMMIT;

