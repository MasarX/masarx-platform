-- Caller claims and SQL role bindings must not inherit SECURITY DEFINER owner authority.
BEGIN;
SET LOCAL lock_timeout = '30s';
SELECT pg_advisory_xact_lock(hashtext('20261031023100_label_caller_authority_v1'));

-- Refuse drift before either replacement; tolerate only CRLF versus LF source storage.
DO $preflight$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.compose_label_payload(uuid)'::regprocedure
      AND prosecdef
      AND encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = 'ece2992bb1841b8efec78538ca5181fa1de1d2e0cde9a7fafea4bb8ae971ab06'
  ) THEN
    RAISE EXCEPTION 'Label caller correction requires the exact current compose_label_payload definition';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc
    WHERE oid = 'public.request_label_reprint(uuid,text,uuid,text)'::regprocedure
      AND prosecdef
      AND encode(sha256(convert_to(replace(prosrc, E'\r\n', E'\n'), 'UTF8')), 'hex') = '0ec1fc180658f40f2ce725d538ba510b6b70d4d022aecb90c38c64314f7fd762'
  ) THEN
    RAISE EXCEPTION 'Label caller correction requires the exact current request_label_reprint definition';
  END IF;
END;
$preflight$;

CREATE OR REPLACE FUNCTION public.compose_label_payload(p_job_id UUID)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, pg_temp
AS $function$
DECLARE
  v_job label_jobs%ROWTYPE;
  v_payload JSONB;
  v_target RECORD;
  v_policy_row RECORD;
  v_print_row RECORD;
  v_policy JSONB;
  v_print_profile JSONB;
  v_policy_resolution_id UUID := NULL;
  v_print_resolution_id UUID := NULL;
  v_scope_type TEXT;
  v_scope_id UUID;
  v_sender_id UUID := NULL;
  v_shipment_metadata JSONB;
  v_explicit_header_mode TEXT;
  v_effective_header_mode TEXT;
  v_claims JSONB := NULLIF(COALESCE(current_setting('request.jwt.claims', true), ''), '')::jsonb;
  v_claim_role TEXT := COALESCE(
    lower(NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), '')),
    lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')),
    lower(NULLIF(btrim(COALESCE(v_claims ->> 'role', '')), ''))
  );
  v_sql_role TEXT := NULLIF(lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), '')), 'none');
  v_has_jwt_context BOOLEAN := v_claim_role IS NOT NULL
    OR COALESCE(v_claims, '{}'::jsonb) <> '{}'::jsonb
    OR NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.sub', true), '')), '') IS NOT NULL;
  v_is_privileged BOOLEAN := CASE
    WHEN v_has_jwt_context THEN COALESCE(v_claim_role IN ('service_role', 'edge_label_renderer_role'), FALSE)
    ELSE COALESCE(COALESCE(v_sql_role, lower(session_user)) IN ('service_role', 'edge_label_renderer_role'), FALSE)
      OR (session_user IN ('postgres', 'supabase_admin')
        AND (v_sql_role IS NULL OR v_sql_role = lower(session_user)))
  END;
BEGIN
  SELECT *
    INTO v_job
    FROM public.label_jobs
   WHERE id = p_job_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Label job % not found', p_job_id;
  END IF;

  IF NOT v_is_privileged THEN
    IF current_user_org_id() IS NULL OR current_user_org_id() <> v_job.organization_id THEN
      RAISE EXCEPTION 'Access denied for label job %', p_job_id;
    END IF;
  END IF;

  IF v_job.shipment_id IS NOT NULL THEN
    SELECT to_jsonb(payload)
      INTO v_payload
      FROM shipment_label_payload_v payload
     WHERE payload.shipment_id = v_job.shipment_id
       AND (
             v_job.shipment_box_id IS NULL
             OR payload.shipment_box_id = v_job.shipment_box_id
           )
     ORDER BY payload.box_number NULLS FIRST
     LIMIT 1;
  ELSE
    SELECT *
      INTO v_target
      FROM public.resolve_label_target_payload(
        v_job.target_type,
        v_job.target_id,
        v_job.target_box_id
      )
     LIMIT 1;
    v_payload := COALESCE(v_target.payload, '{}'::jsonb);
  END IF;

  v_payload := COALESCE(v_payload, '{}'::jsonb);
  v_sender_id := NULLIF(v_payload->>'sender_id', '')::uuid;

  IF v_sender_id IS NOT NULL THEN
    v_scope_type := 'sender';
    v_scope_id := v_sender_id;
  ELSIF v_job.client_id IS NOT NULL THEN
    v_scope_type := 'client';
    v_scope_id := v_job.client_id;
  ELSIF v_job.organization_id IS NOT NULL THEN
    v_scope_type := 'tenant';
    v_scope_id := v_job.organization_id;
  ELSE
    v_scope_type := 'global';
    v_scope_id := NULL;
  END IF;

  SELECT *
    INTO v_policy_row
    FROM public.resolve_settings_row('label_render_policy', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    SELECT *
      INTO v_policy_row
      FROM public.resolve_settings_row('label_render_policy', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_policy_row.value IS NULL THEN
    RAISE EXCEPTION 'label_render_policy missing (global) - seed defaults before rendering';
  END IF;

  v_policy := v_policy_row.value;

  v_policy_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_render_policy',
    p_winning_scope_type := v_policy_row.scope_type,
    p_winning_scope_id := v_policy_row.scope_id,
    p_winning_settings_id := v_policy_row.settings_id,
    p_winning_settings_version_id := v_policy_row.settings_version_id,
    p_winning_version := v_policy_row.version,
    p_scope_path := COALESCE(v_policy_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  SELECT *
    INTO v_print_row
    FROM public.resolve_settings_row('label_print_profile', v_scope_type, v_scope_id)
   LIMIT 1;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    SELECT *
      INTO v_print_row
      FROM public.resolve_settings_row('label_print_profile', 'global', NULL)
     LIMIT 1;
  END IF;

  IF NOT FOUND OR v_print_row.value IS NULL THEN
    RAISE EXCEPTION 'label_print_profile missing (global) - seed defaults before rendering';
  END IF;

  v_print_profile := v_print_row.value;

  v_print_resolution_id := public.log_settings_resolution(
    p_organization_id := v_job.organization_id,
    p_category := 'label_print_profile',
    p_winning_scope_type := v_print_row.scope_type,
    p_winning_scope_id := v_print_row.scope_id,
    p_winning_settings_id := v_print_row.settings_id,
    p_winning_settings_version_id := v_print_row.settings_version_id,
    p_winning_version := v_print_row.version,
    p_scope_path := COALESCE(v_print_row.scope_path, '[]'::jsonb),
    p_inputs := jsonb_strip_nulls(jsonb_build_object(
      'label_job_id', v_job.id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'client_id', v_job.client_id,
      'sender_id', v_sender_id,
      'label_type', v_job.label_type
    )),
    p_merge_notes := NULL
  );

  v_payload := jsonb_set(v_payload, '{label_render_policy}', v_policy, TRUE);
  v_payload := jsonb_set(v_payload, '{label_print_profile}', v_print_profile, TRUE);
  v_payload := jsonb_set(
    v_payload,
    '{label_render_policy_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_policy_resolution_id,
      'winning_scope_type', v_policy_row.scope_type,
      'winning_scope_id', v_policy_row.scope_id,
      'version', v_policy_row.version
    )),
    TRUE
  );
  v_payload := jsonb_set(
    v_payload,
    '{label_print_profile_resolution}',
    jsonb_strip_nulls(jsonb_build_object(
      'settings_resolution_id', v_print_resolution_id,
      'winning_scope_type', v_print_row.scope_type,
      'winning_scope_id', v_print_row.scope_id,
      'version', v_print_row.version
    )),
    TRUE
  );

  v_shipment_metadata := v_payload->'shipment_metadata';
  IF v_shipment_metadata IS NULL OR jsonb_typeof(v_shipment_metadata) <> 'object' THEN
    v_shipment_metadata := '{}'::jsonb;
  END IF;

  v_explicit_header_mode := NULLIF(trim(COALESCE(
    v_shipment_metadata->>'header_brand_mode',
    v_shipment_metadata->>'headerBrandMode'
  )), '');

  v_effective_header_mode := v_explicit_header_mode;
  IF v_effective_header_mode IS NULL THEN
    v_effective_header_mode := NULLIF(trim(v_policy->>'header_brand_mode'), '');
  END IF;

  IF v_effective_header_mode IS NULL THEN
    RAISE EXCEPTION 'label_render_policy.header_brand_mode missing (global) - seed defaults before rendering';
  END IF;

  v_shipment_metadata := jsonb_set(v_shipment_metadata, '{header_brand_mode}', to_jsonb(v_effective_header_mode), TRUE);
  v_payload := jsonb_set(v_payload, '{shipment_metadata}', v_shipment_metadata, TRUE);

  RETURN jsonb_build_object(
    'job', jsonb_build_object(
      'id', v_job.id,
      'organization_id', v_job.organization_id,
      'client_id', v_job.client_id,
      'shipment_id', v_job.shipment_id,
      'shipment_box_id', v_job.shipment_box_id,
      'target_type', v_job.target_type,
      'target_id', v_job.target_id,
      'target_box_id', v_job.target_box_id,
      'target_metadata', COALESCE(v_job.target_metadata, '{}'::jsonb),
      'label_type', v_job.label_type,
      'attempts', v_job.attempts,
      'max_attempts', v_job.max_attempts,
      'template', v_job.template_snapshot,
      'renderer_hint', v_job.renderer_hint,
      'retry_state', v_job.retry_state,
      'workflow_run_step_id', NULL
    ),
    'payload', COALESCE(v_payload, '{}'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.request_label_reprint(
    p_label_id UUID,
    p_reprint_reason TEXT,
    p_actor_id UUID DEFAULT NULL::uuid,
    p_requested_source TEXT DEFAULT 'reprint'::text
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
    v_label RECORD;
    v_template_snapshot JSONB;
    v_template_version INTEGER;
    v_template_id UUID;
    v_retry JSONB;
    v_max_attempts INTEGER;
    v_job_id UUID;
    v_context JSONB;
    v_workflow_run_id UUID;
    v_workflow_run_step_id UUID;
    v_created_wrapper BOOLEAN := FALSE;
    v_reprint_reason TEXT := NULLIF(btrim(COALESCE(p_reprint_reason, '')), '');
    v_source_label_version_id UUID := NULL;
    v_source_label_version_number INTEGER := NULL;
    v_claims JSONB := NULLIF(COALESCE(current_setting('request.jwt.claims', true), ''), '')::jsonb;
    v_claim_role TEXT := COALESCE(
      lower(NULLIF(btrim(COALESCE(auth.jwt() ->> 'role', '')), '')),
      lower(NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.role', true), '')), '')),
      lower(NULLIF(btrim(COALESCE(v_claims ->> 'role', '')), ''))
    );
    v_sql_role TEXT := NULLIF(lower(NULLIF(btrim(COALESCE(current_setting('role', true), '')), '')), 'none');
    v_has_jwt_context BOOLEAN := v_claim_role IS NOT NULL
      OR COALESCE(v_claims, '{}'::jsonb) <> '{}'::jsonb
      OR NULLIF(btrim(COALESCE(current_setting('request.jwt.claim.sub', true), '')), '') IS NOT NULL;
    v_is_privileged BOOLEAN := CASE
      WHEN v_has_jwt_context THEN COALESCE(v_claim_role IN ('service_role'), FALSE)
      ELSE COALESCE(COALESCE(v_sql_role, lower(session_user)) IN ('service_role'), FALSE)
        OR (session_user IN ('postgres', 'supabase_admin')
          AND (v_sql_role IS NULL OR v_sql_role = lower(session_user)))
    END;
BEGIN
    SELECT
        l.*,
        s.organization_id,
        s.client_id,
        s.sender_id,
        sb.id AS matched_box_id
    INTO v_label
    FROM public.labels l
    JOIN public.shipments s ON s.id = l.shipment_id
    LEFT JOIN public.shipment_boxes sb ON sb.barcode = l.barcode
    WHERE l.id = p_label_id;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Label % not found', p_label_id;
    END IF;

    IF NOT v_is_privileged THEN
        IF current_user_org_id() IS NULL OR current_user_org_id() <> v_label.organization_id THEN
            RAISE EXCEPTION 'Access denied for label %', p_label_id;
        END IF;
    END IF;

    SELECT label_version_id, version_number
    INTO v_source_label_version_id, v_source_label_version_number
    FROM public.ensure_label_active_version_v1(v_label.id, v_label.shipment_id);

    v_template_snapshot := COALESCE(v_label.metadata -> 'template', '{}'::jsonb);

    IF jsonb_typeof(v_template_snapshot) IS DISTINCT FROM 'object'
        OR v_template_snapshot = '{}'::jsonb THEN
        SELECT
            rt.template_snapshot,
            rt.template_version,
            rt.template_id,
            rt.max_attempts,
            rt.retry_backoff
        INTO v_template_snapshot,
             v_template_version,
             v_template_id,
             v_max_attempts,
             v_retry
        FROM public.resolve_label_template(
            v_label.organization_id,
            v_label.client_id,
            v_label.sender_id,
            v_label.label_type
        ) AS rt
        LIMIT 1;
    ELSE
        v_template_version := COALESCE((v_template_snapshot ->> 'template_version')::INTEGER, 1);
        v_template_id := COALESCE(v_label.layout_template_id, (v_template_snapshot ->> 'template_id')::UUID);
        v_retry := COALESCE(v_template_snapshot -> 'label_config' -> 'retry_backoff_seconds', '[]'::jsonb);
        v_max_attempts := COALESCE((v_template_snapshot -> 'label_config' ->> 'max_attempts')::INTEGER, 5);
    END IF;

    IF v_template_id IS NULL THEN
        RAISE EXCEPTION 'Template reference missing for label %', p_label_id;
    END IF;

    v_context := jsonb_strip_nulls(jsonb_build_object(
        'organization_id', v_label.organization_id,
        'client_id', v_label.client_id,
        'sender_id', v_label.sender_id,
        'shipment_id', v_label.shipment_id,
        'shipment_box_id', v_label.matched_box_id,
        'label_id', p_label_id,
        'label_type', v_label.label_type,
        'job_purpose', 'reprint',
        'requested_source', p_requested_source,
        'source_label_version_id', v_source_label_version_id
    ));

    SELECT workflow_run_id, workflow_run_step_id, created_wrapper
    INTO v_workflow_run_id, v_workflow_run_step_id, v_created_wrapper
    FROM public.ensure_label_job_workflow_context(v_context)
    LIMIT 1;

    INSERT INTO public.label_jobs (
        organization_id,
        client_id,
        shipment_id,
        shipment_box_id,
        label_id,
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
        reprint_reason,
        source_label_version_id,
        renderer_hint,
        retry_state,
        workflow_run_step_id
    )
    VALUES (
        v_label.organization_id,
        v_label.client_id,
        v_label.shipment_id,
        v_label.matched_box_id,
        p_label_id,
        v_label.label_type,
        v_template_id,
        v_template_version,
        v_template_snapshot,
        'pending',
        0,
        COALESCE(v_max_attempts, 5),
        now(),
        'reprint',
        gen_random_uuid()::text,
        p_actor_id,
        p_requested_source,
        v_reprint_reason,
        v_source_label_version_id,
        v_template_snapshot -> 'label_config' ->> 'provider_hint',
        COALESCE(v_retry, '[]'::jsonb),
        v_workflow_run_step_id
    )
    RETURNING id INTO v_job_id;

    IF v_created_wrapper AND v_job_id IS NOT NULL THEN
      UPDATE public.workflow_run_steps
      SET operation_result = jsonb_strip_nulls(jsonb_build_object(
            'label_job_id', v_job_id,
            'label_type', v_label.label_type,
            'job_purpose', 'reprint',
            'source_label_version_id', v_source_label_version_id
          )),
          updated_at = now()
      WHERE id = v_workflow_run_step_id;

      UPDATE public.workflow_runs
      SET context = jsonb_strip_nulls(COALESCE(context, '{}'::jsonb) || jsonb_build_object(
            'label_job_id', v_job_id,
            'label_job_status', 'pending'
          )),
          updated_at = now()
      WHERE id = v_workflow_run_id;
    END IF;

    PERFORM public.log_decision(
        p_organization_id := v_label.organization_id,
        p_decision_category := 'label_job',
        p_resource_type := 'label_job',
        p_resource_id := v_job_id,
        p_decision_point := 'request_label_reprint',
        p_decision_outcome := 'enqueued',
        p_performed_by_system := 'workflow_engine',
        p_correlation_id := NULL,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
            'label_id', p_label_id,
            'label_type', v_label.label_type,
            'template_id', v_template_id,
            'template_version', v_template_version,
            'requested_source', p_requested_source,
            'source_label_version_id', v_source_label_version_id,
            'source_label_version_number', v_source_label_version_number
        )),
        p_decision_reason := v_reprint_reason
    );

    RETURN v_job_id;
END;
$function$;

COMMIT;
