-- Preserve duplicate lead identity and recover missing follow-ups without weakening atomicity.
BEGIN;
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketing_demo_request_create_v1(
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
AS $$
DECLARE
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
  v_now TIMESTAMPTZ := now();
  v_id UUID := gen_random_uuid();
  v_email TEXT := btrim(COALESCE(p_email, ''));
  v_company TEXT := btrim(COALESCE(p_company, ''));
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');
  v_recent_count INT := 0;
BEGIN
  v_policy := public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid);

  v_enabled := COALESCE(NULLIF(v_policy->>'enabled', '')::BOOLEAN, FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_turnstile_required := COALESCE(NULLIF(v_policy#>>'{turnstile,required}', '')::BOOLEAN, TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_email = '' OR position('@' IN v_email) = 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;

  IF v_company = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'company_required'));
  END IF;

  v_window_seconds := COALESCE(NULLIF(v_policy#>>'{rate_limit,window_seconds}', '')::INT, 60);
  v_max_requests := COALESCE(NULLIF(v_policy#>>'{rate_limit,max_requests}', '')::INT, 15);
  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.marketing_demo_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  v_dedupe_seconds := COALESCE(NULLIF(v_policy#>>'{dedupe,window_seconds}', '')::INT, 3600);
  IF v_dedupe_seconds > 0 THEN
    IF current_setting('transaction_isolation') NOT IN ('read committed', 'read uncommitted') THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object(
        'code', 'server_misconfigured', 'message', 'marketing_dedupe_requires_read_committed'
      ));
    END IF;

    -- The transaction retains this per-email lock through the caller's task dispatch.
    PERFORM pg_advisory_xact_lock(hashtextextended('marketing_demo_intake:' || v_email, 0));
    SELECT r.id
      INTO v_id
      FROM public.marketing_demo_requests r
     WHERE r.email = v_email
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC, r.id DESC
     LIMIT 1;
    IF FOUND THEN
      RETURN jsonb_build_object('ok', TRUE, 'deduped', TRUE, 'id', v_id);
    END IF;
    v_id := gen_random_uuid();
  END IF;

  INSERT INTO public.marketing_demo_requests (
    id,
    created_at,
    email,
    company,
    volume,
    role,
    notes,
    locale,
    page_url,
    referrer,
    origin,
    marketing,
    ip_hash,
    turnstile_verified
  ) VALUES (
    v_id,
    v_now,
    v_email,
    v_company,
    NULLIF(btrim(COALESCE(p_volume, '')), ''),
    NULLIF(btrim(COALESCE(p_role, '')), ''),
    NULLIF(btrim(COALESCE(p_notes, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    COALESCE(p_marketing, '{}'::jsonb),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_id);
END;
$$;


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
  v_dispatch_idempotency_key TEXT;
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

  SELECT t.id, t.workflow_run_id
    INTO v_task_id, v_task_workflow_run_id
    FROM public.tasks t
    JOIN public.task_types tt ON tt.id = t.task_type_id
   WHERE t.organization_id = v_org_id
     AND t.resource_type = 'marketing_lead_request'
     AND t.resource_id = v_lead_id
     AND tt.key = v_task_type_key
     AND t.idempotency_key = format('marketing_lead_followup:%s', v_lead_id);
  IF FOUND THEN
    RETURN v_result || jsonb_strip_nulls(jsonb_build_object(
      'task_id', v_task_id, 'workflow_run_id', v_task_workflow_run_id
    ));
  END IF;

  v_dispatch_idempotency_key := format('marketing_lead_followup:%s', v_lead_id);
  IF COALESCE((v_result->>'deduped')::BOOLEAN, FALSE) IS TRUE THEN
    v_dispatch_idempotency_key := format('marketing_lead_followup:%s:repair:%s', v_lead_id, gen_random_uuid());
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
      'idempotency_key', v_dispatch_idempotency_key,
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


-- CREATE OR REPLACE preserves the current service-only implementation and API grants.
COMMIT;
