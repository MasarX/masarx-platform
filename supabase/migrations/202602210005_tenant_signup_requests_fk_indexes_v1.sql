-- Ensure FK hygiene: every tenant_signup_requests FK column has a supporting full index.
CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_reviewed_by
  ON public.tenant_signup_requests (reviewed_by);

CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_approved_organization_id
  ON public.tenant_signup_requests (approved_organization_id);

CREATE INDEX IF NOT EXISTS idx_tenant_signup_requests_approved_user_id
  ON public.tenant_signup_requests (approved_user_id);
