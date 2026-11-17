-- Plan: PLAN-202604-b06-closeout / Step: Correct label target role fallback to session_user

BEGIN;

SELECT pg_advisory_lock(hashtext('202604102270_uc078_label_target_role_resolution_v2'));
SET search_path TO public, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.request_label_generation_target_v1(
  p_target_type TEXT,
  p_target_id UUID,
  p_label_type TEXT,
  p_requested_by UUID DEFAULT NULL,
  p_requested_source TEXT DEFAULT NULL,
  p_target_box_id UUID DEFAULT NULL,
  p_job_purpose TEXT DEFAULT 'primary'
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_target_type TEXT := public.normalize_label_target_type(p_target_type);
  v_target RECORD;
  v_template RECORD;
  v_job_id UUID;
  v_idempotency_key TEXT;
  v_retry_backoff JSONB;
  v_job_purpose TEXT := COALESCE(NULLIF(p_job_purpose, ''), 'primary');
  v_inserted BOOLEAN := FALSE;
  v_label_type TEXT := COALESCE(NULLIF(lower(btrim(p_label_type)), ''), public.default_label_type_for_target_type(p_target_type));
  v_jwt_role TEXT := NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), '');
  v_claims JSONB := NULLIF(COALESCE(current_setting('request.jwt.claims', true), ''), '')::jsonb;
  v_effective_role TEXT := COALESCE(
    v_jwt_role,
    NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), ''),
    NULLIF(btrim(COALESCE(v_claims ->> 'role', '')), ''),
    CASE
      WHEN session_user IN ('postgres', 'supabase_admin') THEN 'service_role'
      ELSE lower(session_user)
    END
  );
BEGIN
  IF v_target_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported label target type %', p_target_type
      USING ERRCODE = '22023';
  END IF;

  IF p_target_id IS NULL THEN
    RAISE EXCEPTION 'Label target id is required'
      USING ERRCODE = '23502';
  END IF;

  IF v_label_type IS NULL THEN
    RAISE EXCEPTION 'Label type is required for target %', p_target_type
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_target
    FROM public.resolve_label_target_payload(v_target_type, p_target_id, p_target_box_id)
   LIMIT 1;

  IF v_target.organization_id IS NULL THEN
    RAISE EXCEPTION 'Target % not found for organization lookup', p_target_id
      USING ERRCODE = '23503';
  END IF;

  IF v_effective_role NOT IN ('service_role', 'edge_label_renderer_role') THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_target.organization_id THEN
      RAISE EXCEPTION 'Access denied for label target %', p_target_id;
    END IF;
  END IF;

  SELECT *
    INTO v_template
    FROM public.resolve_label_template(
      v_target.organization_id,
      v_target.client_id,
      NULL,
      v_label_type
    )
   LIMIT 1;

  IF v_template.template_id IS NULL THEN
    RAISE EXCEPTION 'Unable to resolve label template for target % label_type %', p_target_id, v_label_type;
  END IF;

  v_retry_backoff := COALESCE(v_template.retry_backoff, '[]'::jsonb);
  v_idempotency_key := format(
    '%s:%s:%s:%s:%s:%s:%s',
    v_target.organization_id,
    v_target_type,
    p_target_id,
    COALESCE(p_target_box_id::text, '00000000-0000-0000-0000-000000000000'),
    v_label_type,
    v_template.template_id,
    v_job_purpose
  );

  INSERT INTO public.label_jobs (
    organization_id,
    client_id,
    shipment_id,
    shipment_box_id,
    target_type,
    target_id,
    target_box_id,
    target_metadata,
    label_type,
    template_id,
    template_version,
    template_snapshot,
    status,
    attempts,
    max_attempts,
    scheduled_at,
    job_purpose,
    idempotency_key,
    requested_by,
    requested_source,
    renderer_hint,
    retry_state
  )
  VALUES (
    v_target.organization_id,
    v_target.client_id,
    NULL,
    NULL,
    v_target_type,
    p_target_id,
    p_target_box_id,
    COALESCE(v_target.payload, '{}'::jsonb),
    v_label_type,
    v_template.template_id,
    v_template.template_version,
    v_template.template_snapshot,
    'pending',
    0,
    COALESCE(v_template.max_attempts, 5),
    now(),
    v_job_purpose,
    v_idempotency_key,
    p_requested_by,
    p_requested_source,
    v_template.template_snapshot -> 'label_config' ->> 'provider_hint',
    v_retry_backoff
  )
  ON CONFLICT ON CONSTRAINT label_jobs_unique_request DO NOTHING
  RETURNING id INTO v_job_id;

  IF v_job_id IS NOT NULL THEN
    v_inserted := TRUE;
  END IF;

  IF v_job_id IS NULL THEN
    SELECT id
      INTO v_job_id
      FROM public.label_jobs
     WHERE organization_id = v_target.organization_id
       AND target_type = v_target_type
       AND target_id = p_target_id
       AND target_box_id IS NOT DISTINCT FROM p_target_box_id
       AND label_type = v_label_type
       AND template_id = v_template.template_id
       AND job_purpose = v_job_purpose
     ORDER BY created_at DESC
     LIMIT 1;
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_target.organization_id,
    p_decision_category := 'label_job',
    p_resource_type := 'label_job',
    p_resource_id := v_job_id,
    p_decision_point := 'request_label_generation_target',
    p_decision_outcome := CASE WHEN v_inserted THEN 'enqueued' ELSE 'reused' END,
    p_performed_by_system := 'workflow_engine',
    p_correlation_id := NULL,
    p_decision_inputs := jsonb_build_object(
      'target_type', v_target_type,
      'target_id', p_target_id,
      'target_box_id', p_target_box_id,
      'label_type', v_label_type,
      'template_id', v_template.template_id,
      'template_version', v_template.template_version,
      'job_purpose', v_job_purpose
    ),
    p_decision_reason := CASE WHEN v_inserted THEN NULL ELSE 'idempotent_reuse' END
  );

  RETURN v_job_id;
END;
$function$;

COMMENT ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT)
  IS 'Create or return an idempotent label job for a non-shipment target and label type. JWT role detection falls back through auth.jwt(), request.jwt.claim.role, request.jwt.claims, then session_user for breakglass sessions only.';

SELECT pg_advisory_unlock(hashtext('202604102270_uc078_label_target_role_resolution_v2'));

COMMIT;
