-- Migration: Workflow template start policy gate for Console V2 workflow starts.
-- Keeps generic workflow-run starts row-driven while allowing domain-owned
-- workflows to require their owning write capability.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605162305_workflow_template_start_policy_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE TABLE IF NOT EXISTS public.workflow_template_start_policy (
  workflow_template_id UUID NOT NULL REFERENCES public.workflow_templates(id) ON DELETE CASCADE,
  required_capability TEXT NOT NULL,
  scope_type TEXT NOT NULL DEFAULT 'tenant',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workflow_template_id, required_capability),
  CONSTRAINT workflow_template_start_policy_capability_nonempty CHECK (btrim(required_capability) <> ''),
  CONSTRAINT workflow_template_start_policy_scope_type_nonempty CHECK (btrim(scope_type) <> '')
);

COMMENT ON TABLE public.workflow_template_start_policy IS
  'Row-driven supplemental capability policy for public.ui_start_workflow_run_v1. Domain workflows can require their owning write capability in addition to workflow_runs.write.';

DROP TRIGGER IF EXISTS trg_workflow_template_start_policy_set_updated_at ON public.workflow_template_start_policy;
CREATE TRIGGER trg_workflow_template_start_policy_set_updated_at
  BEFORE UPDATE ON public.workflow_template_start_policy
  FOR EACH ROW
  EXECUTE FUNCTION public.set_updated_at();

ALTER TABLE public.workflow_template_start_policy ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.workflow_template_start_policy FROM PUBLIC;
REVOKE ALL ON TABLE public.workflow_template_start_policy FROM anon;
REVOKE ALL ON TABLE public.workflow_template_start_policy FROM authenticated;
GRANT SELECT ON TABLE public.workflow_template_start_policy TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.workflow_template_start_policy TO service_role;

DROP POLICY IF EXISTS workflow_template_start_policy_authenticated_select ON public.workflow_template_start_policy;
CREATE POLICY workflow_template_start_policy_authenticated_select
  ON public.workflow_template_start_policy
  FOR SELECT
  TO authenticated
  USING (TRUE);

DROP POLICY IF EXISTS workflow_template_start_policy_service_all ON public.workflow_template_start_policy;
CREATE POLICY workflow_template_start_policy_service_all
  ON public.workflow_template_start_policy
  FOR ALL
  TO service_role
  USING (TRUE)
  WITH CHECK (TRUE);

INSERT INTO public.workflow_template_start_policy (
  workflow_template_id,
  required_capability,
  scope_type,
  is_active,
  metadata
)
VALUES (
  '99990000-0000-0000-0000-000000570004'::uuid,
  'finance.write',
  'tenant',
  TRUE,
  jsonb_build_object(
    'template_key', 'bank_deposit_reconciliation_v2',
    'reason', 'Bank reconciliation start mutates finance workflow state'
  )
)
ON CONFLICT (workflow_template_id, required_capability) DO UPDATE
SET scope_type = EXCLUDED.scope_type,
    is_active = EXCLUDED.is_active,
    metadata = EXCLUDED.metadata,
    updated_at = now();

CREATE OR REPLACE FUNCTION public.ui_start_workflow_run_v1(
  p_workflow_template_id UUID,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_require_active BOOLEAN DEFAULT TRUE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_scope_type TEXT := public.current_user_scope_type();
  v_scope_id UUID := public.current_user_scope_id();
  v_require_active BOOLEAN := COALESCE(p_require_active, TRUE);
  v_context JSONB;
  v_run_id UUID;
  v_policy RECORD;
BEGIN
  PERFORM public.assert_capability_v1('workflow_runs.write', v_scope_type, v_scope_id);

  FOR v_policy IN
    SELECT required_capability, scope_type
      FROM public.workflow_template_start_policy
     WHERE workflow_template_id = p_workflow_template_id
       AND is_active IS TRUE
     ORDER BY required_capability
  LOOP
    PERFORM public.assert_capability_v1(
      v_policy.required_capability,
      COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type),
      CASE
        WHEN COALESCE(NULLIF(v_policy.scope_type, ''), v_scope_type) = v_scope_type
          THEN v_scope_id
        WHEN v_policy.scope_type = 'tenant'
          THEN public.current_user_org_id()
        ELSE v_scope_id
      END
    );
  END LOOP;

  v_context := jsonb_build_object(
    'trigger_source', 'manual',
    'organization_id', public.current_user_org_id(),
    'requested_by', auth.uid(),
    'payload', COALESCE(p_payload, '{}'::jsonb),
    'ui', jsonb_build_object(
      'allow_inactive', (NOT v_require_active),
      'workflow_template_id', p_workflow_template_id
    )
  );

  v_run_id := start_workflow_run(p_workflow_template_id, v_context);

  RETURN jsonb_build_object(
    'status', 'workflow_started',
    'workflow_template_id', p_workflow_template_id,
    'workflow_run_id', v_run_id
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) IS
  'Browser-safe workflow start wrapper. Requires workflow_runs.write plus any active row-driven workflow_template_start_policy capability for the requested template.';

REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_start_workflow_run_v1(UUID, JSONB, BOOLEAN) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605162305_workflow_template_start_policy_v1'));
COMMIT;
