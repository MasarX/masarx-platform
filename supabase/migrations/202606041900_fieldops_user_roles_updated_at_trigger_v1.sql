-- Migration: FieldOps user roles updated_at trigger repair
-- Purpose: keep fieldops_user_roles aligned with the standard timestamp contract.

DROP TRIGGER IF EXISTS trg_fieldops_user_roles_set_updated_at ON public.fieldops_user_roles;
CREATE TRIGGER trg_fieldops_user_roles_set_updated_at
BEFORE UPDATE ON public.fieldops_user_roles
FOR EACH ROW
EXECUTE FUNCTION public.set_updated_at();
