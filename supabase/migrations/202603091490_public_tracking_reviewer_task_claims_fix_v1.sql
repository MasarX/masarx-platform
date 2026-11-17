-- Plan: PLAN-202603-customer-shipment-change-review-flow / Step: S02
-- The task engine resolves service context from request.jwt.claims, so set
-- both role shims before creating reviewer tasks from public tracking.

CREATE OR REPLACE FUNCTION public.public_tracking_create_reviewer_task_v1(
  p_support_case_id UUID,
  p_organization_id UUID,
  p_policy JSONB,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_enabled BOOLEAN := public.public_tracking_bool_v1(p_policy, ARRAY['notifications','reviewer_in_app'], TRUE);
  v_task_org_slug TEXT := NULLIF(btrim(COALESCE(p_policy #>> ARRAY['notifications','task','organization_slug'], '')), '');
  v_task_org_id UUID := p_organization_id;
  v_task_type_key TEXT;
  v_task_queue TEXT;
  v_task_priority INT;
  v_task_sla_minutes INT;
  v_task_id UUID;
  v_workflow_run_id UUID;
BEGIN
  IF NOT v_enabled OR p_support_case_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'disabled');
  END IF;

  IF v_task_org_slug IS NOT NULL THEN
    SELECT o.id
      INTO v_task_org_id
      FROM public.organizations o
     WHERE o.slug = v_task_org_slug
     LIMIT 1;
  END IF;

  IF v_task_org_id IS NULL THEN
    RETURN jsonb_build_object(
      'queued', FALSE,
      'reason', 'task_org_missing',
      'organization_slug', v_task_org_slug
    );
  END IF;

  v_task_type_key := public.public_tracking_text_v1(
    p_policy,
    ARRAY['notifications','task','task_type_key'],
    'customer_shipment_change_review'
  );
  v_task_queue := NULLIF(btrim(COALESCE(p_policy #>> ARRAY['notifications','task','queue_key'], '')), '');
  v_task_priority := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','priority'], 40, 0, 1000);
  v_task_sla_minutes := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','sla_minutes'], 60, 1, 10080);

  PERFORM set_config('request.jwt.claim.role', 'service_role', TRUE);
  PERFORM set_config('request.jwt.claims', '{"role":"service_role"}', TRUE);

  SELECT t.task_id, t.workflow_run_id
    INTO v_task_id, v_workflow_run_id
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_task_org_id),
          'resource_type', 'support_case',
          'resource_id', p_support_case_id,
          'queue_key', v_task_queue,
          'priority', v_task_priority,
          'sla_minutes', v_task_sla_minutes,
          'idempotency_key', format('customer_shipment_change_review:%s', p_support_case_id),
          'metadata', COALESCE(p_metadata, '{}'::jsonb),
          'actor_system', 'public_tracking'
        )
      )
    ) AS t
   LIMIT 1;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'queued', TRUE,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id,
      'organization_id', v_task_org_id
    )
  );
END;
$function$;
