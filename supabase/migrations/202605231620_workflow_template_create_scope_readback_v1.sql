-- Console V2 workflow template create scope readback hardening.
-- Platform operators working inside an active tenant lens must create
-- tenant-visible workflow templates, not hidden platform-scoped rows.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605231620_workflow_template_create_scope_readback_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.ui_create_workflow_template_v1(p_args jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
SET row_security = on
AS $function$
DECLARE
  v_args jsonb := COALESCE(p_args, '{}'::jsonb);
  v_name text := NULLIF(btrim(COALESCE(v_args->>'name', v_args->>'template_name', '')), '');
  v_description text := NULLIF(btrim(COALESCE(v_args->>'description', v_args->>'template_description', '')), '');
  v_clone_from uuid := NULLIF(COALESCE(v_args->>'clone_from', v_args->>'clone_from_template_id', v_args->>'source_template_id'), '')::uuid;
  v_trigger_event text := NULLIF(btrim(COALESCE(v_args->>'trigger', v_args->>'trigger_event', '')), '');
  v_requested_scope_type text := lower(NULLIF(btrim(COALESCE(v_args->>'scope_type', v_args->>'target_scope_type', '')), ''));
  v_requested_scope_id uuid := NULLIF(COALESCE(v_args->>'scope_id', v_args->>'target_scope_id', ''), '')::uuid;
  v_scope_type text := lower(COALESCE(v_requested_scope_type, public.current_user_scope_type(), 'global'));
  v_scope_id uuid := COALESCE(v_requested_scope_id, public.current_user_scope_id());
  v_current_org_id uuid := public.current_user_org_id();
  v_template_id uuid;
  v_metadata jsonb := '{}'::jsonb;
  v_clone_metadata jsonb;
BEGIN
  IF v_name IS NULL THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 requires name'
      USING ERRCODE = '23502';
  END IF;

  PERFORM public.assert_capability_v1('workflows.write');

  IF v_scope_type = 'platform' THEN
    v_scope_type := 'tenant';
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
  END IF;

  IF v_scope_type NOT IN ('global', 'tenant', 'client', 'sender') THEN
    RAISE EXCEPTION 'ui_create_workflow_template_v1 invalid scope_type %', v_scope_type
      USING ERRCODE = '22023';
  END IF;

  IF v_scope_type = 'global' THEN
    v_scope_id := NULL;
    IF NOT public.is_platform_user() THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 global scope requires platform user'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'tenant' THEN
    v_scope_id := COALESCE(v_scope_id, v_current_org_id);
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 tenant scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND v_current_org_id IS DISTINCT FROM v_scope_id THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 tenant scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'client' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 client scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND NOT EXISTS (
      SELECT 1 FROM public.clients c
       WHERE c.id = v_scope_id
         AND c.organization_id = v_current_org_id
    ) THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 client scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  ELSIF v_scope_type = 'sender' THEN
    IF v_scope_id IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 sender scope requires scope_id'
        USING ERRCODE = '23502';
    END IF;
    IF NOT public.is_platform_user() AND NOT EXISTS (
      SELECT 1
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_scope_id
         AND c.organization_id = v_current_org_id
    ) THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 sender scope outside caller organization'
        USING ERRCODE = '42501';
    END IF;
  END IF;

  IF v_clone_from IS NOT NULL THEN
    SELECT COALESCE(wt.metadata, '{}'::jsonb)
      INTO v_clone_metadata
      FROM public.workflow_templates wt
     WHERE wt.id = v_clone_from
     LIMIT 1;

    IF v_clone_metadata IS NULL THEN
      RAISE EXCEPTION 'ui_create_workflow_template_v1 clone template not found'
        USING ERRCODE = '23503';
    END IF;

    v_metadata := v_clone_metadata || jsonb_build_object('source_template_id', v_clone_from::text);
  END IF;

  IF v_trigger_event IS NOT NULL THEN
    v_metadata := v_metadata || jsonb_build_object('trigger_event', v_trigger_event);
  END IF;

  INSERT INTO public.workflow_templates (
    name,
    description,
    status,
    version,
    scope_type,
    scope_id,
    created_by,
    metadata
  )
  VALUES (
    v_name,
    v_description,
    'draft',
    1,
    v_scope_type,
    v_scope_id,
    auth.uid(),
    v_metadata
  )
  RETURNING id INTO v_template_id;

  IF v_clone_from IS NOT NULL THEN
    INSERT INTO public.workflow_template_steps (
      workflow_template_id,
      sequence_order,
      operation_name,
      operation_settings_category,
      transition_condition,
      condition_jsonlogic,
      next_operation_name,
      next_operation_priority,
      next_operation_delay_seconds,
      manual_action_required,
      metadata,
      enabled
    )
    SELECT
      v_template_id,
      step.sequence_order,
      step.operation_name,
      step.operation_settings_category,
      step.transition_condition,
      step.condition_jsonlogic,
      step.next_operation_name,
      step.next_operation_priority,
      step.next_operation_delay_seconds,
      step.manual_action_required,
      step.metadata,
      step.enabled
    FROM public.workflow_template_steps step
    WHERE step.workflow_template_id = v_clone_from
    ORDER BY step.sequence_order ASC;
  END IF;

  RETURN jsonb_build_object(
    'status', 'ok',
    'workflow_template_id', v_template_id::text,
    'scope_type', v_scope_type,
    'scope_id', v_scope_id::text
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_create_workflow_template_v1(jsonb)
  IS 'Console V2 browser-safe p_args wrapper for canonical workflow template creation. Accepts validated scope_type/scope_id so active-tenant Console creates are immediately readable in the same tenant lens.';

SELECT pg_advisory_unlock(hashtext('202605231620_workflow_template_create_scope_readback_v1'));
COMMIT;
