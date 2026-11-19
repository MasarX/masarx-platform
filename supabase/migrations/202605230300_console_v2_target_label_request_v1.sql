-- Console V2 target-label request wrapper.
-- Keeps the renderer/service target-label function private while exposing a
-- scoped, capability-gated browser path for operator-created route/container/
-- transfer labels.

BEGIN;
SELECT pg_advisory_lock(hashtext('202605230300_console_v2_target_label_request_v1'));
SET search_path TO public, extensions, pg_temp;

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
    IF public.is_platform_user() THEN
      IF NOT public.user_has_capability_v1('labels.reprint', 'tenant', v_target.organization_id) THEN
        RAISE EXCEPTION 'Access denied for label target %', p_target_id;
      END IF;
    ELSIF public.current_user_org_id() IS NULL OR public.current_user_org_id() <> v_target.organization_id THEN
      RAISE EXCEPTION 'Access denied for label target %', p_target_id;
    ELSIF NOT public.user_has_capability_v1('labels.reprint', 'tenant', v_target.organization_id) THEN
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

  v_template.template_snapshot := jsonb_set(
    COALESCE(v_template.template_snapshot, '{}'::jsonb),
    '{label_config,fallback_barcode}',
    to_jsonb(COALESCE(NULLIF(v_target.barcode, ''), p_target_id::text)),
    TRUE
  );

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
  IS 'Create or return an idempotent label job for a non-shipment target and label type. Authenticated callers remain denied direct EXECUTE; trusted wrappers enforce scope and labels.reprint.';

REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO service_role;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'edge_label_renderer_role') THEN
    GRANT EXECUTE ON FUNCTION public.request_label_generation_target_v1(TEXT, UUID, TEXT, UUID, TEXT, UUID, TEXT) TO edge_label_renderer_role;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.ui_request_label_generation_target_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_args JSONB := COALESCE(p_args, '{}'::jsonb);
  v_actor_id UUID := auth.uid();
  v_target_type TEXT := public.normalize_label_target_type(v_args ->> 'target_type');
  v_target_id UUID := NULLIF(v_args ->> 'target_id', '')::uuid;
  v_target_box_id UUID := NULLIF(v_args ->> 'target_box_id', '')::uuid;
  v_label_type TEXT := NULLIF(lower(btrim(COALESCE(v_args ->> 'label_type', ''))), '');
  v_requested_org UUID := NULLIF(v_args ->> 'organization_id', '')::uuid;
  v_requested_source TEXT := COALESCE(NULLIF(v_args ->> 'requested_source', ''), 'console-v2');
  v_job_purpose TEXT := COALESCE(NULLIF(v_args ->> 'job_purpose', ''), 'primary');
  v_target RECORD;
  v_job_id UUID;
  v_job JSONB;
BEGIN
  IF v_actor_id IS NULL THEN
    RAISE EXCEPTION 'Authentication required';
  END IF;

  IF v_target_type IS NULL THEN
    RAISE EXCEPTION 'Unsupported label target type %', v_args ->> 'target_type'
      USING ERRCODE = '22023';
  END IF;

  IF v_target_type NOT IN ('route_run', 'handling_unit', 'warehouse_transfer') THEN
    RAISE EXCEPTION 'Unsupported browser label target type %', v_target_type
      USING ERRCODE = '22023';
  END IF;

  IF v_target_id IS NULL THEN
    RAISE EXCEPTION 'Label target id is required'
      USING ERRCODE = '23502';
  END IF;

  SELECT *
    INTO v_target
    FROM public.resolve_label_target_payload(v_target_type, v_target_id, v_target_box_id)
   LIMIT 1;

  IF v_target.organization_id IS NULL THEN
    RAISE EXCEPTION 'Target % not found for organization lookup', v_target_id
      USING ERRCODE = '23503';
  END IF;

  IF public.is_platform_user() THEN
    IF v_requested_org IS NULL OR v_requested_org <> v_target.organization_id THEN
      RAISE EXCEPTION 'Platform label target request must include the active tenant organization';
    END IF;
  ELSIF public.current_user_org_id() IS NULL OR public.current_user_org_id() <> v_target.organization_id THEN
    RAISE EXCEPTION 'Access denied for label target %', v_target_id;
  END IF;

  IF NOT public.user_has_capability_v1('labels.reprint', 'tenant', v_target.organization_id) THEN
    RAISE EXCEPTION 'labels.reprint capability is required';
  END IF;

  v_job_id := public.request_label_generation_target_v1(
    p_target_type := v_target_type,
    p_target_id := v_target_id,
    p_label_type := v_label_type,
    p_requested_by := v_actor_id,
    p_requested_source := v_requested_source,
    p_target_box_id := v_target_box_id,
    p_job_purpose := v_job_purpose
  );

  SELECT to_jsonb(lj)
    INTO v_job
    FROM public.label_jobs lj
   WHERE lj.id = v_job_id
     AND lj.organization_id = v_target.organization_id;

  IF v_job IS NULL THEN
    RAISE EXCEPTION 'Label job readback missing for %', v_job_id;
  END IF;

  RETURN jsonb_build_object(
    'ok', true,
    'label_job_id', v_job_id,
    'target_type', v_target_type,
    'target_id', v_target_id,
    'target_box_id', v_target_box_id,
    'label_type', COALESCE(v_job ->> 'label_type', v_label_type),
    'status', v_job ->> 'status',
    'job', v_job
  );
END;
$function$;

COMMENT ON FUNCTION public.ui_request_label_generation_target_v1(JSONB)
  IS 'Console V2 browser-safe target-label enqueue wrapper. Validates visible target scope, active tenant for platform users, and labels.reprint before calling the service-only target label RPC.';

REVOKE ALL ON FUNCTION public.ui_request_label_generation_target_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.ui_request_label_generation_target_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION public.ui_request_label_generation_target_v1(JSONB) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION api.ui_request_label_generation_target_v1(
  p_args JSONB
)
RETURNS JSONB
LANGUAGE SQL
SECURITY INVOKER
SET search_path TO api, public, pg_temp
AS $$
  SELECT public.ui_request_label_generation_target_v1(p_args);
$$;

REVOKE ALL ON FUNCTION api.ui_request_label_generation_target_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION api.ui_request_label_generation_target_v1(JSONB) FROM anon;
GRANT EXECUTE ON FUNCTION api.ui_request_label_generation_target_v1(JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202605230300_console_v2_target_label_request_v1'));
COMMIT;
