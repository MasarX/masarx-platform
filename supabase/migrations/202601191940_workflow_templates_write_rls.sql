-- Migration: Add authenticated write policies for workflow templates and steps
-- Purpose: Enable workflow studio edits with capability checks and scope isolation.
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191940_workflow_templates_write_rls'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DROP POLICY IF EXISTS workflow_templates_authenticated_insert ON public.workflow_templates;
CREATE POLICY workflow_templates_authenticated_insert
  ON public.workflow_templates
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND workflow_template_scope_allowed(scope_type, scope_id)
    AND (scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
  );

DROP POLICY IF EXISTS workflow_templates_authenticated_update ON public.workflow_templates;
CREATE POLICY workflow_templates_authenticated_update
  ON public.workflow_templates
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND workflow_template_scope_allowed(scope_type, scope_id)
    AND (scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
    AND (status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
  )
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND workflow_template_scope_allowed(scope_type, scope_id)
    AND (scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
    AND (status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
  );

DROP POLICY IF EXISTS workflow_templates_authenticated_delete ON public.workflow_templates;
CREATE POLICY workflow_templates_authenticated_delete
  ON public.workflow_templates
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND workflow_template_scope_allowed(scope_type, scope_id)
    AND (scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
    AND (status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
  );

DROP POLICY IF EXISTS workflow_template_steps_authenticated_insert ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_authenticated_insert
  ON public.workflow_template_steps
  FOR INSERT
  TO authenticated
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_template_steps.workflow_template_id
        AND workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
        AND (wt.scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
        AND (wt.status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
    )
  );

DROP POLICY IF EXISTS workflow_template_steps_authenticated_update ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_authenticated_update
  ON public.workflow_template_steps
  FOR UPDATE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_template_steps.workflow_template_id
        AND workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
        AND (wt.scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
        AND (wt.status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
    )
  )
  WITH CHECK (
    public.user_has_capability_v1('workflow_runs.write')
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_template_steps.workflow_template_id
        AND workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
        AND (wt.scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
        AND (wt.status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
    )
  );

DROP POLICY IF EXISTS workflow_template_steps_authenticated_delete ON public.workflow_template_steps;
CREATE POLICY workflow_template_steps_authenticated_delete
  ON public.workflow_template_steps
  FOR DELETE
  TO authenticated
  USING (
    public.user_has_capability_v1('workflow_runs.write')
    AND EXISTS (
      SELECT 1
      FROM public.workflow_templates wt
      WHERE wt.id = workflow_template_steps.workflow_template_id
        AND workflow_template_scope_allowed(wt.scope_type, wt.scope_id)
        AND (wt.scope_type IS DISTINCT FROM 'global' OR public.user_has_capability_v1('system.write'))
        AND (wt.status IS DISTINCT FROM 'active' OR public.user_has_capability_v1('system.write'))
    )
  );

SELECT pg_advisory_unlock(hashtext('202601191940_workflow_templates_write_rls'));
COMMIT;

