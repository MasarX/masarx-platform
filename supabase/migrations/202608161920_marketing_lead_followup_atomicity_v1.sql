-- Make marketing lead creation and its canonical workflow follow-up all-or-nothing.
BEGIN;
SELECT pg_advisory_lock(hashtext('202608161920_marketing_lead_followup_atomicity_v1'));

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
  v_dispatch_id UUID := NULL;
  v_binding_workflow_run_id UUID := NULL;
  v_dispatch_count INT := 0;
  v_task_count INT := 0;
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
  BEGIN v_dispatch_id := NULLIF(v_dispatch_result->>'dispatch_id', '')::UUID; EXCEPTION WHEN others THEN v_dispatch_id := NULL; END;
  BEGIN v_binding_workflow_run_id := NULLIF(v_dispatch_result->>'workflow_run_id', '')::UUID; EXCEPTION WHEN others THEN v_binding_workflow_run_id := NULL; END;

  SELECT count(*)::INT
    INTO v_dispatch_count
    FROM public.workflow_binding_dispatches d
   WHERE d.id = v_dispatch_id
     AND d.workflow_run_id = v_binding_workflow_run_id
     AND d.binding_key = 'marketing_lead'
     AND d.stage_key = 'review_requested'
     AND d.organization_id = v_org_id
     AND d.resource_type = 'marketing_lead_request'
     AND d.resource_id = v_lead_id
     AND d.outcome = 'completed';

  SELECT count(*)::INT
    INTO v_task_count
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.id = v_task_id
     AND t.organization_id = v_org_id
     AND t.resource_type = 'marketing_lead_request'
     AND t.resource_id = v_lead_id
     AND tt.key = v_task_type_key
     AND t.idempotency_key = format('marketing_lead_followup:%s', v_lead_id);

  IF COALESCE(v_dispatch_result->>'ok', 'false') <> 'true'
     OR COALESCE(v_dispatch_result->>'outcome', '') <> 'completed'
     OR v_dispatch_id IS NULL
     OR v_binding_workflow_run_id IS NULL
     OR v_task_id IS NULL
     OR v_dispatch_count <> 1
     OR v_task_count <> 1 THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'marketing_lead_followup_atomicity_failed';
  END IF;

  RETURN v_result || jsonb_strip_nulls(
    jsonb_build_object(
      'task_id', v_task_id,
      'workflow_run_id', v_task_workflow_run_id,
      'dispatch_id', v_dispatch_id,
      'binding_workflow_run_id', v_binding_workflow_run_id
    )
  );
END;
$function$;

COMMENT ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Atomic marketing lead intake: a new lead succeeds only with one completed marketing_lead/review_requested dispatch and its exact canonical follow-up task; failures roll back the statement.';

SELECT pg_advisory_unlock(hashtext('202608161920_marketing_lead_followup_atomicity_v1'));
COMMIT;
