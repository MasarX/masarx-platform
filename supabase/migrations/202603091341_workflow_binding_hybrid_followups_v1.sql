-- Plan: PLAN-202603-workflow-binding-business-actions / Step: S04
-- Migration: Adopt workflow bindings for public-tracking follow-ups and marketing lead intake
-- Date: 2026-03-09
--
-- Purpose:
-- - Route public-tracking requester notifications and reviewer task creation through
--   run_workflow_binding_stage_v1 instead of direct outbound/task calls.
-- - Route marketing lead follow-up task creation through the same generic binding substrate.

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091341_workflow_binding_hybrid_followups_v1'));
SET search_path TO public, workflow_handlers, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.workflow_binding_dispatch_step_result_v1(
  p_dispatch_result JSONB
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF jsonb_typeof(COALESCE(p_dispatch_result->'step_operation_result', 'null'::jsonb)) = 'object' THEN
    RETURN p_dispatch_result->'step_operation_result';
  END IF;

  IF jsonb_typeof(COALESCE(p_dispatch_result #> ARRAY['inline_progress_result', 'operation_result'], 'null'::jsonb)) = 'object' THEN
    RETURN p_dispatch_result #> ARRAY['inline_progress_result', 'operation_result'];
  END IF;

  RETURN '{}'::jsonb;
END;
$function$;

CREATE OR REPLACE FUNCTION public.public_tracking_enqueue_recipient_notification_v1(
  p_support_case_id UUID,
  p_organization_id UUID,
  p_recipient_id UUID,
  p_stage TEXT,
  p_message TEXT,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_case RECORD;
  v_binding_stage TEXT := NULL;
  v_dispatch_result JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;
BEGIN
  IF p_recipient_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'missing_recipient_id');
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = p_support_case_id
  LIMIT 1;

  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'support_case_not_found');
  END IF;

  v_binding_stage := CASE lower(COALESCE(NULLIF(btrim(p_stage), ''), ''))
    WHEN 'received' THEN 'request_received'
    WHEN 'applied' THEN 'post_apply'
    WHEN 'rejected' THEN 'post_reject'
    ELSE NULL
  END;

  IF v_binding_stage IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'unsupported_stage');
  END IF;

  v_dispatch_result := public.run_workflow_binding_stage_v1(
    jsonb_build_object(
      'binding_key', 'customer_shipment_change',
      'stage_key', v_binding_stage,
      'organization_id', v_case.organization_id,
      'client_id', v_case.client_id,
      'sender_id', v_case.sender_id,
      'resource_type', 'support_case',
      'resource_id', p_support_case_id,
      'actor_system', 'public_tracking',
      'source_function', 'public_tracking_enqueue_recipient_notification_v1',
      'idempotency_key', format('customer_shipment_change:%s:%s', v_binding_stage, p_support_case_id),
      'context', jsonb_build_object(
        'binding_payload',
        jsonb_build_object(
          'notification',
          jsonb_strip_nulls(
            jsonb_build_object(
              'support_case_id', p_support_case_id,
              'organization_id', COALESCE(p_organization_id, v_case.organization_id),
              'recipient_id', p_recipient_id,
              'stage', lower(COALESCE(NULLIF(btrim(p_stage), ''), '')),
              'message', p_message,
              'payload', COALESCE(p_payload, '{}'::jsonb)
            )
          )
        )
      )
    )
  );

  v_step_result := public.workflow_binding_dispatch_step_result_v1(v_dispatch_result);

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'queued', COALESCE((v_step_result->>'queued')::BOOLEAN, FALSE),
      'channel', NULLIF(v_step_result->>'channel', ''),
      'outbound_call_id', NULLIF(v_step_result->>'outbound_call_id', '')::UUID,
      'dispatch_id', NULLIF(v_dispatch_result->>'dispatch_id', '')::UUID,
      'binding_workflow_run_id', NULLIF(v_dispatch_result->>'workflow_run_id', '')::UUID,
      'reason',
        CASE
          WHEN COALESCE((v_step_result->>'queued')::BOOLEAN, FALSE) THEN NULL
          ELSE COALESCE(v_step_result->>'reason', v_dispatch_result #>> ARRAY['error', 'code'])
        END
    )
  );
END;
$function$;

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
  v_nil_uuid CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_enabled BOOLEAN := public.public_tracking_bool_v1(p_policy, ARRAY['notifications','reviewer_in_app'], TRUE);
  v_task_org_slug TEXT := NULLIF(btrim(COALESCE(p_policy #>> ARRAY['notifications','task','organization_slug'], '')), '');
  v_case RECORD;
  v_task_org_id UUID := NULLIF(p_organization_id, v_nil_uuid);
  v_task_type_key TEXT;
  v_task_queue TEXT;
  v_task_priority INT;
  v_task_sla_minutes INT;
  v_dispatch_result JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;
  v_task_id UUID := NULL;
  v_task_workflow_run_id UUID := NULL;
BEGIN
  IF NOT v_enabled OR p_support_case_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'disabled');
  END IF;

  SELECT
    sc.id,
    sc.organization_id,
    sc.client_id,
    sc.sender_id
  INTO v_case
  FROM public.support_cases sc
  WHERE sc.id = p_support_case_id
  LIMIT 1;

  IF v_case.id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'support_case_not_found');
  END IF;

  v_task_org_id := COALESCE(v_task_org_id, NULLIF(v_case.organization_id, v_nil_uuid));

  IF v_task_org_slug IS NOT NULL THEN
    SELECT NULLIF(o.id, v_nil_uuid)
      INTO v_task_org_id
      FROM public.organizations o
     WHERE o.slug = v_task_org_slug
     LIMIT 1;
  END IF;

  v_task_org_id := COALESCE(v_task_org_id, NULLIF(v_case.organization_id, v_nil_uuid));
  IF v_task_org_id IS NULL THEN
    RETURN jsonb_build_object('queued', FALSE, 'reason', 'task_org_missing', 'organization_slug', v_task_org_slug);
  END IF;

  v_task_type_key := public.public_tracking_text_v1(
    p_policy,
    ARRAY['notifications','task','task_type_key'],
    'customer_shipment_change_review'
  );
  v_task_queue := NULLIF(btrim(COALESCE(p_policy #>> ARRAY['notifications','task','queue_key'], '')), '');
  v_task_priority := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','priority'], 40, 0, 1000);
  v_task_sla_minutes := public.public_tracking_int_v1(p_policy, ARRAY['notifications','task','sla_minutes'], 60, 1, 10080);

  v_dispatch_result := public.run_workflow_binding_stage_v1(
    jsonb_build_object(
      'binding_key', 'customer_shipment_change',
      'stage_key', 'review_requested',
      'organization_id', v_case.organization_id,
      'client_id', v_case.client_id,
      'sender_id', v_case.sender_id,
      'resource_type', 'support_case',
      'resource_id', p_support_case_id,
      'actor_system', 'public_tracking',
      'source_function', 'public_tracking_create_reviewer_task_v1',
      'idempotency_key', format('customer_shipment_change_review:%s', p_support_case_id),
      'context', jsonb_build_object(
        'binding_payload',
        jsonb_build_object(
          'task',
          jsonb_strip_nulls(
            jsonb_build_object(
              'organization_id', v_task_org_id,
              'task_type_key', v_task_type_key,
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
        )
      )
    )
  );

  v_step_result := public.workflow_binding_dispatch_step_result_v1(v_dispatch_result);
  BEGIN v_task_id := NULLIF(v_step_result->>'task_id', '')::UUID; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_task_workflow_run_id := NULLIF(v_step_result->>'workflow_run_id', '')::UUID; EXCEPTION WHEN others THEN v_task_workflow_run_id := NULL; END;

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'queued', COALESCE(v_task_id IS NOT NULL, FALSE),
      'task_id', v_task_id,
      'workflow_run_id', v_task_workflow_run_id,
      'dispatch_id', NULLIF(v_dispatch_result->>'dispatch_id', '')::UUID,
      'binding_workflow_run_id', NULLIF(v_dispatch_result->>'workflow_run_id', '')::UUID,
      'organization_id', v_task_org_id,
      'reason',
        CASE
          WHEN v_task_id IS NOT NULL THEN NULL
          ELSE COALESCE(v_step_result->>'reason', v_dispatch_result #>> ARRAY['error', 'code'])
        END
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketing_lead_request_create_v1(
  p_email TEXT,
  p_company TEXT,
  p_volume TEXT DEFAULT NULL,
  p_role TEXT DEFAULT NULL,
  p_notes TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_policy JSONB;
  v_task_cfg JSONB := '{}'::jsonb;
  v_org_slug TEXT := NULL;
  v_task_type_key TEXT := NULL;
  v_queue_key TEXT := NULL;
  v_priority INT := NULL;
  v_sla_minutes INT := NULL;
  v_org_id UUID := NULL;
  v_result JSONB := '{}'::jsonb;
  v_lead_id UUID := NULL;
  v_dispatch_result JSONB := '{}'::jsonb;
  v_step_result JSONB := '{}'::jsonb;
  v_task_id UUID := NULL;
  v_task_workflow_run_id UUID := NULL;
BEGIN
  BEGIN
    v_claims := current_setting('request.jwt.claims', true)::jsonb;
  EXCEPTION
    WHEN others THEN
      v_claims := NULL;
  END;
  v_role := NULLIF(btrim(COALESCE(v_claims->>'role', '')), '');

  IF session_user IS DISTINCT FROM 'postgres'
     AND session_user IS DISTINCT FROM 'supabase_admin'
     AND v_role IS DISTINCT FROM 'service_role' THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'server_misconfigured', 'message', 'service_role_required')
    );
  END IF;

  v_policy := public.resolve_settings_merged('marketing_demo_intake_policy', public.get_root_scope_type_key_v1(), NULL::uuid);
  v_task_cfg := COALESCE(v_policy->'task', '{}'::jsonb);

  v_org_slug := NULLIF(btrim(COALESCE(v_task_cfg->>'organization_slug', '')), '');
  IF v_org_slug IS NULL THEN
    v_org_slug := 'global-root';
  END IF;

  v_task_type_key := lower(NULLIF(btrim(COALESCE(v_task_cfg->>'task_type_key', '')), ''));
  IF v_task_type_key IS NULL THEN
    v_task_type_key := 'marketing_lead_followup';
  END IF;

  v_queue_key := NULLIF(btrim(COALESCE(v_task_cfg->>'queue_key', '')), '');
  BEGIN v_priority := NULLIF(v_task_cfg->>'priority', '')::INT; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_task_cfg->>'sla_minutes', '')::INT; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;

  SELECT o.id
    INTO v_org_id
    FROM public.organizations o
   WHERE o.slug = v_org_slug
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'server_misconfigured', 'message', 'organization_slug_not_found')
    );
  END IF;

  v_result := public.marketing_demo_request_create_v1(
    p_email,
    p_company,
    p_volume,
    p_role,
    p_notes,
    p_locale,
    p_page_url,
    p_referrer,
    p_origin,
    p_marketing,
    p_ip_hash,
    p_turnstile_verified
  );

  IF COALESCE(v_result->>'ok', 'false') <> 'true' THEN
    RETURN v_result;
  END IF;

  IF COALESCE((v_result->>'deduped')::BOOLEAN, FALSE) IS TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_lead_id := NULLIF(v_result->>'id', '')::UUID;
  EXCEPTION
    WHEN others THEN
      v_lead_id := NULL;
  END;

  IF v_lead_id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', FALSE,
      'error', jsonb_build_object('code', 'server_misconfigured', 'message', 'lead_id_missing')
    );
  END IF;

  v_dispatch_result := public.run_workflow_binding_stage_v1(
    jsonb_build_object(
      'binding_key', 'marketing_lead',
      'stage_key', 'review_requested',
      'organization_id', v_org_id,
      'resource_type', 'marketing_lead_request',
      'resource_id', v_lead_id,
      'actor_system', 'marketing-lead-intake',
      'source_function', 'marketing_lead_request_create_v1',
      'idempotency_key', format('marketing_lead_followup:%s', v_lead_id),
      'context', jsonb_build_object(
        'binding_payload',
        jsonb_build_object(
          'task',
          jsonb_strip_nulls(
            jsonb_build_object(
              'organization_id', v_org_id,
              'task_type_key', v_task_type_key,
              'resource_type', 'marketing_lead_request',
              'resource_id', v_lead_id,
              'queue_key', v_queue_key,
              'priority', v_priority,
              'sla_minutes', v_sla_minutes,
              'idempotency_key', format('marketing_lead_followup:%s', v_lead_id),
              'metadata', jsonb_strip_nulls(
                jsonb_build_object(
                  'lead_id', v_lead_id,
                  'email', NULLIF(btrim(COALESCE(p_email, '')), ''),
                  'company', NULLIF(btrim(COALESCE(p_company, '')), ''),
                  'volume', NULLIF(btrim(COALESCE(p_volume, '')), ''),
                  'role', NULLIF(btrim(COALESCE(p_role, '')), ''),
                  'notes', NULLIF(btrim(COALESCE(p_notes, '')), '')
                )
              ),
              'actor_system', 'marketing-lead-intake'
            )
          )
        )
      )
    )
  );

  v_step_result := public.workflow_binding_dispatch_step_result_v1(v_dispatch_result);
  BEGIN v_task_id := NULLIF(v_step_result->>'task_id', '')::UUID; EXCEPTION WHEN others THEN v_task_id := NULL; END;
  BEGIN v_task_workflow_run_id := NULLIF(v_step_result->>'workflow_run_id', '')::UUID; EXCEPTION WHEN others THEN v_task_workflow_run_id := NULL; END;

  RETURN v_result || jsonb_strip_nulls(
    jsonb_build_object(
      'task_id', v_task_id,
      'workflow_run_id', v_task_workflow_run_id,
      'dispatch_id', NULLIF(v_dispatch_result->>'dispatch_id', '')::UUID,
      'binding_workflow_run_id', NULLIF(v_dispatch_result->>'workflow_run_id', '')::UUID
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Marketing lead intake RPC: uses marketing_demo_request_create_v1 (SSOT validation/insert), then dispatches marketing_lead/review_requested via workflow bindings. Returns {ok,id,deduped?,task_id?,workflow_run_id?}.';

REVOKE ALL ON FUNCTION public.workflow_binding_dispatch_step_result_v1(JSONB) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.workflow_binding_dispatch_step_result_v1(JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603091341_workflow_binding_hybrid_followups_v1'));
COMMIT;
