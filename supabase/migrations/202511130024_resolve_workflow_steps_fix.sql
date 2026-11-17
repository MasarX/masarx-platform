-- Migration: resolve_workflow_steps qualification fix

BEGIN;

CREATE OR REPLACE FUNCTION public.resolve_workflow_steps(
    p_workflow_template_id UUID
)
RETURNS TABLE (
    workflow_template_step_id UUID,
    sequence_order INT,
    operation_name TEXT
)
LANGUAGE plpgsql
SET search_path TO 'public, pg_temp'
AS $$
BEGIN
    RETURN QUERY
    SELECT wts.id, wts.sequence_order, wts.operation_name
    FROM public.workflow_template_steps wts
    WHERE wts.workflow_template_id = p_workflow_template_id
      AND wts.enabled = TRUE
    ORDER BY wts.sequence_order;
END;
$$;

COMMIT;

