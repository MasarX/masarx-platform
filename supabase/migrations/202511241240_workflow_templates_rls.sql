-- Migration: workflow template RLS hardening
-- Purpose: enforce multi-tenant read isolation across workflow templates and steps

BEGIN;

SET search_path TO public, pg_temp;

-- Helper to determine whether current authenticated user can access a workflow scope.
CREATE OR REPLACE FUNCTION public.workflow_template_scope_allowed(
    p_scope_type TEXT,
    p_scope_id UUID
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
    v_org UUID := current_user_org_id();
BEGIN
    IF v_org IS NULL THEN
        RETURN FALSE;
    END IF;

    IF p_scope_type IS NULL OR p_scope_type = '' OR p_scope_type = 'global' THEN
        RETURN TRUE;
    ELSIF p_scope_type = 'tenant' THEN
        RETURN p_scope_id = v_org;
    ELSIF p_scope_type = 'client' THEN
        RETURN EXISTS (
            SELECT 1
            FROM public.clients c
            WHERE c.id = p_scope_id
              AND c.organization_id = v_org
        );
    ELSIF p_scope_type = 'sender' THEN
        RETURN EXISTS (
            SELECT 1
            FROM public.senders s
            JOIN public.clients c ON c.id = s.client_id
            WHERE s.id = p_scope_id
              AND c.organization_id = v_org
        );
    ELSE
        RETURN FALSE;
    END IF;
END;
$function$;

COMMENT ON FUNCTION public.workflow_template_scope_allowed(TEXT, UUID)
    IS 'Return TRUE when current authenticated user is permitted to access workflow template scope.';

ALTER TABLE public.workflow_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.workflow_template_steps ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workflow_templates FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_template_steps FROM PUBLIC;

REVOKE ALL ON TABLE public.workflow_templates FROM anon, authenticated;
REVOKE ALL ON TABLE public.workflow_template_steps FROM anon, authenticated;

DROP POLICY IF EXISTS workflow_templates_service_role ON public.workflow_templates;
CREATE POLICY workflow_templates_service_role
  ON public.workflow_templates
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_template_steps_service_role ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_service_role
  ON public.workflow_template_steps
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

DROP POLICY IF EXISTS workflow_templates_authenticated_select ON public.workflow_templates;
CREATE POLICY workflow_templates_authenticated_select
  ON public.workflow_templates
  FOR SELECT
  TO authenticated
  USING (workflow_template_scope_allowed(scope_type, scope_id));

DROP POLICY IF EXISTS workflow_template_steps_authenticated_select ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_authenticated_select
  ON public.workflow_template_steps
  FOR SELECT
  TO authenticated
  USING (
    EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_template_steps.workflow_template_id
        AND workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
    )
  );

COMMIT;
