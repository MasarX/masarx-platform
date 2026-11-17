-- Plan: PLAN-202602-landing-contact-sales-intake / Step: S04
-- Migration: marketing_lead_request_create_v1 (lead SSOT + internal follow-up task; atomic)
-- Date: 2026-02-14
--
-- Notes:
--   - Keeps SSOT lead storage in public.marketing_demo_requests (append-only; do not rename historical table).
--   - Reuses public.marketing_demo_request_create_v1 for validation + throttling + insert (no duplicated logic).
--   - Creates an internal task via public.create_task_system_v1 (service_role-only; idempotent per lead id).

BEGIN;
SET search_path TO public, extensions, pg_temp;

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
AS $$
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

  v_task_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
BEGIN
  -- This RPC creates internal tasks, so it must run in service-only context.
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

  -- Resolve task routing config from the existing intake policy category (row-driven).
  v_policy := public.resolve_settings_merged('marketing_demo_intake_policy', 'global', NULL::uuid);
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
  BEGIN v_priority := NULLIF(v_task_cfg->>'priority', '')::int; EXCEPTION WHEN others THEN v_priority := NULL; END;
  BEGIN v_sla_minutes := NULLIF(v_task_cfg->>'sla_minutes', '')::int; EXCEPTION WHEN others THEN v_sla_minutes := NULL; END;

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

  -- Create the SSOT lead row via the existing intake RPC (validates + rate limits + dedupes).
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

  IF COALESCE((v_result->>'deduped')::boolean, FALSE) IS TRUE THEN
    RETURN v_result;
  END IF;

  BEGIN
    v_lead_id := NULLIF(v_result->>'id', '')::uuid;
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

  -- Create internal follow-up task (idempotent per lead id).
  SELECT t.task_id, t.workflow_run_id
    INTO v_task_id, v_workflow_run_id
    FROM public.create_task_system_v1(
      jsonb_strip_nulls(
        jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object('organization_id', v_org_id),
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
    ) AS t
   LIMIT 1;

  RETURN v_result || jsonb_strip_nulls(jsonb_build_object('task_id', v_task_id, 'workflow_run_id', v_workflow_run_id));
END;
$$;

COMMENT ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN)
  IS 'Marketing lead intake RPC: uses marketing_demo_request_create_v1 (SSOT validation/insert), then creates a follow-up task via create_task_system_v1 (service-only, idempotent). Returns {ok,id,deduped?,task_id?,workflow_run_id?}.';

REVOKE EXECUTE ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM anon;
REVOKE EXECUTE ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.marketing_lead_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, TEXT, BOOLEAN) TO service_role;

COMMIT;

