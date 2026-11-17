-- Terminal runtime failure-wave reconciliation.
-- Keeps active history append-only while closing the exact post-1860 runtime union.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-------------------------------------------------------------------------------
-- FieldOps marketplace intake: exact-scope identity dedupe and canonical status.
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_create_v1(
  p_requested_participant_type_key TEXT,
  p_email TEXT,
  p_full_name TEXT,
  p_organization_name TEXT,
  p_organization_slug TEXT DEFAULT NULL,
  p_phone TEXT DEFAULT NULL,
  p_website_url TEXT DEFAULT NULL,
  p_locale TEXT DEFAULT NULL,
  p_page_url TEXT DEFAULT NULL,
  p_referrer TEXT DEFAULT NULL,
  p_origin TEXT DEFAULT NULL,
  p_experience_summary TEXT DEFAULT NULL,
  p_capabilities_requested JSONB DEFAULT '[]'::jsonb,
  p_verification_documents JSONB DEFAULT '[]'::jsonb,
  p_marketing JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb,
  p_requested_organization_id UUID DEFAULT NULL,
  p_requested_by_user_id UUID DEFAULT NULL,
  p_ip_hash TEXT DEFAULT NULL,
  p_turnstile_verified BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_type_key TEXT := lower(btrim(COALESCE(p_requested_participant_type_key, '')));
  v_email TEXT := lower(btrim(COALESCE(p_email, '')));
  v_phone TEXT := NULLIF(regexp_replace(COALESCE(p_phone, ''), '[^0-9]+', '', 'g'), '');
  v_employee_id TEXT := NULLIF(lower(btrim(COALESCE(p_marketing->>'employee_or_contractor_id', ''))), '');
  v_full_name TEXT := btrim(COALESCE(p_full_name, ''));
  v_org_name TEXT := btrim(COALESCE(p_organization_name, ''));
  v_org_slug TEXT := NULLIF(btrim(COALESCE(p_organization_slug, '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');
  v_now TIMESTAMPTZ := now();
  v_policy JSONB;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
  v_recent_count INT := 0;
  v_existing public.marketplace_participant_requests%ROWTYPE;
  v_dedupe_reason TEXT;
  v_scope_key TEXT;
  v_request_id UUID := gen_random_uuid();
  v_status_token UUID := gen_random_uuid();
  v_task_enabled BOOLEAN := TRUE;
  v_task_org_slug TEXT := 'global-root';
  v_task_type_key TEXT := 'marketplace_participant_review';
  v_task_queue TEXT := 'marketplace_participant_review';
  v_task_priority INT := 45;
  v_task_sla_minutes INT := 120;
  v_task_org_id UUID := NULL;
  v_task_id UUID := NULL;
  v_workflow_run_id UUID := NULL;
BEGIN
  v_policy := public.marketplace_compliance_policy_v1(jsonb_build_object(
    'organization_id', p_requested_organization_id,
    'participant_type_key', v_type_key
  ));

  IF NOT public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;
  IF p_requested_organization_id IS NULL
     AND NOT public.tenant_signup_policy_bool_v1(
       v_policy, ARRAY['participant_types', v_type_key, 'allow_public_intake'], FALSE
     ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'public_intake_not_allowed'));
  END IF;
  IF public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE)
     AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;
  IF v_type_key = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_required'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.marketplace_registry_entries e
    WHERE e.registry_type = 'participant_type'
      AND e.entry_key = v_type_key
      AND e.is_active
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_invalid'));
  END IF;
  IF v_email = '' OR position('@' IN v_email) < 2 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_email'));
  END IF;
  IF v_full_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'full_name_required'));
  END IF;
  IF v_org_name = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'organization_required'));
  END IF;

  v_window_seconds := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400
  );
  v_max_requests := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000
  );
  v_dedupe_seconds := public.tenant_signup_policy_int_v1(
    v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 31536000
  );

  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT count(*) INTO v_recent_count
    FROM public.marketplace_participant_requests r
    WHERE r.ip_hash = v_ip_hash
      AND r.created_at >= v_now - make_interval(secs => v_window_seconds);
    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  v_scope_key := CASE
    WHEN p_requested_organization_id IS NOT NULL
      THEN 'organization:' || p_requested_organization_id::TEXT
    ELSE 'public:' || lower(v_org_name) || ':' || lower(COALESCE(v_org_slug, ''))
  END;

  -- Fixed lock order serializes every canonical identity in the exact request scope.
  PERFORM pg_advisory_xact_lock(hashtextextended(
    'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':email:' || v_email, 0
  ));
  IF v_phone IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':phone:' || v_phone, 0
    ));
  END IF;
  IF v_employee_id IS NOT NULL THEN
    PERFORM pg_advisory_xact_lock(hashtextextended(
      'marketplace_participant_request:' || v_scope_key || ':' || v_type_key || ':employee:' || v_employee_id, 0
    ));
  END IF;

  IF v_dedupe_seconds > 0 THEN
    SELECT r.* INTO v_existing
    FROM public.marketplace_participant_requests r
    WHERE r.requested_participant_type_key = v_type_key
      AND (
        (p_requested_organization_id IS NOT NULL AND r.requested_organization_id = p_requested_organization_id)
        OR (
          p_requested_organization_id IS NULL
          AND r.requested_organization_id IS NULL
          AND lower(btrim(r.organization_name)) = lower(v_org_name)
          AND lower(btrim(COALESCE(r.organization_slug, ''))) = lower(COALESCE(v_org_slug, ''))
        )
      )
      AND r.created_at >= v_now - make_interval(secs => v_dedupe_seconds)
      AND (
        lower(r.email) = v_email
        OR (v_phone IS NOT NULL AND regexp_replace(COALESCE(r.phone, ''), '[^0-9]+', '', 'g') = v_phone)
        OR (
          v_employee_id IS NOT NULL
          AND lower(btrim(COALESCE(r.marketing->>'employee_or_contractor_id', ''))) = v_employee_id
        )
      )
    ORDER BY
      CASE
        WHEN lower(r.email) = v_email THEN 1
        WHEN v_phone IS NOT NULL
          AND regexp_replace(COALESCE(r.phone, ''), '[^0-9]+', '', 'g') = v_phone THEN 2
        ELSE 3
      END,
      r.created_at DESC
    LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      v_dedupe_reason := CASE
        WHEN lower(v_existing.email) = v_email THEN 'email'
        WHEN v_phone IS NOT NULL
          AND regexp_replace(COALESCE(v_existing.phone, ''), '[^0-9]+', '', 'g') = v_phone THEN 'phone'
        ELSE 'employee_or_contractor_id'
      END;
      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', v_existing.status,
        'deduped', TRUE,
        'dedupe_reason', v_dedupe_reason
      );
    END IF;
  END IF;

  INSERT INTO public.marketplace_participant_requests (
    id, status, requested_participant_type_key, requested_by_user_id,
    requested_organization_id, email, full_name, organization_name,
    organization_slug, phone, website_url, locale, page_url, referrer, origin,
    experience_summary, capabilities_requested, verification_documents,
    marketing, metadata, ip_hash, turnstile_verified, public_status_token
  ) VALUES (
    v_request_id, 'pending', v_type_key, p_requested_by_user_id,
    p_requested_organization_id, v_email, v_full_name, v_org_name,
    v_org_slug, NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_website_url, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    NULLIF(btrim(COALESCE(p_experience_summary, '')), ''),
    CASE WHEN jsonb_typeof(p_capabilities_requested) = 'array' THEN p_capabilities_requested ELSE '[]'::jsonb END,
    CASE WHEN jsonb_typeof(p_verification_documents) = 'array' THEN p_verification_documents ELSE '[]'::jsonb END,
    COALESCE(p_marketing, '{}'::jsonb), COALESCE(p_metadata, '{}'::jsonb),
    v_ip_hash, COALESCE(p_turnstile_verified, FALSE), v_status_token
  );

  v_task_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['task', 'enabled'], TRUE);
  v_task_org_slug := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'organization_slug'], ''), 'global-root');
  v_task_type_key := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'task_type_key'], ''), 'marketplace_participant_review');
  v_task_queue := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'queue_key'], ''), 'marketplace_participant_review');
  v_task_priority := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'priority'], 45, 0, 1000);
  v_task_sla_minutes := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'sla_minutes'], 120, 0, 10080);

  IF v_task_enabled THEN
    SELECT o.id INTO v_task_org_id
    FROM public.organizations o
    WHERE o.slug = v_task_org_slug
    LIMIT 1;
    IF v_task_org_id IS NOT NULL THEN
      BEGIN
        SELECT t.task_id, t.workflow_run_id INTO v_task_id, v_workflow_run_id
        FROM public.create_task_system_v1(jsonb_build_object(
          'task_type_key', v_task_type_key,
          'context', jsonb_build_object(
            'organization_id', v_task_org_id,
            'marketplace_participant_request_id', v_request_id,
            'requested_participant_type_key', v_type_key,
            'requested_organization_id', p_requested_organization_id
          ),
          'resource_type', 'marketplace_participant_request',
          'resource_id', v_request_id,
          'queue_key', v_task_queue,
          'priority', v_task_priority,
          'sla_minutes', v_task_sla_minutes,
          'idempotency_key', 'marketplace-participant-request:' || v_request_id::TEXT,
          'metadata', jsonb_build_object(
            'organization_id', v_task_org_id,
            'source', 'marketplace_participant_request_create_v1'
          ),
          'actor_system', 'marketplace_participant_request_create_v1'
        )) AS t;
      EXCEPTION WHEN others THEN
        PERFORM public.marketplace_participant_request_record_error_v1(
          v_request_id, 'task_create_failed', SQLERRM, jsonb_build_object('sqlstate', SQLSTATE)
        );
      END;
    END IF;
  END IF;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(p_requested_organization_id, public.marketplace_system_org_id_v1()),
    'marketplace_participant_request', v_request_id, 'participant_request.created',
    jsonb_build_object(
      'requested_participant_type_key', v_type_key,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );

  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'id', v_request_id,
    'status', 'pending',
    'task_id', v_task_id,
    'workflow_run_id', v_workflow_run_id,
    'application_status_token', v_status_token
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_participant_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_create_v1(
  TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT,
  TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN
) TO service_role;

CREATE OR REPLACE FUNCTION public.marketplace_application_status_by_token_v1(p_status_token UUID)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_state TEXT := 'pending_review';
  v_additional_docs_requested BOOLEAN := FALSE;
  v_handoff_ready BOOLEAN := FALSE;
  v_driver_profile_id UUID := NULL;
  v_fleet_driver_status TEXT := NULL;
  v_fleet_document_count INTEGER := 0;
  v_fleet_compliance_event_count INTEGER := 0;
  v_review_reason_edge_case TEXT := NULL;
BEGIN
  SELECT * INTO v_req
  FROM public.marketplace_participant_requests r
  WHERE r.public_status_token = p_status_token
  LIMIT 1;
  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;
  IF NULLIF(btrim(COALESCE(v_req.review_reason, '')), '') IS NOT NULL THEN
    SELECT NULLIF(lv.metadata->>'edge_case', '') INTO v_review_reason_edge_case
    FROM public.lookup_definitions ld
    JOIN public.lookup_values lv ON lv.lookup_definition_id = ld.id
    WHERE ld.category = 'marketplace_participant_review_reason'
      AND lv.value = v_req.review_reason
      AND COALESCE(lv.status, 'active') = 'active'
    LIMIT 1;
  END IF;
  v_additional_docs_requested := lower(COALESCE(
    v_req.decision_metadata->>'request_additional_docs', 'false'
  )) IN ('true', 't', '1', 'yes');
  IF v_req.status = 'approved' THEN
    v_state := CASE WHEN COALESCE(v_req.last_error_code, '') = 'reverification_required'
      THEN 'reverification_required' ELSE 'approved' END;
  ELSIF v_req.status = 'rejected' THEN
    v_state := CASE WHEN COALESCE(
      v_req.decision_metadata->>'edge_case', v_review_reason_edge_case, ''
    ) = 'compliance_denied' THEN 'compliance_denied' ELSE 'rejected' END;
  ELSIF v_additional_docs_requested THEN
    v_state := 'additional_documents_requested';
  END IF;
  v_handoff_ready := v_req.status = 'approved'
    AND v_req.approved_user_id IS NOT NULL
    AND v_req.approved_participant_profile_id IS NOT NULL
    AND v_req.approved_organization_id IS NOT NULL;
  IF v_req.status = 'approved'
     AND v_req.approved_user_id IS NOT NULL
     AND v_req.approved_organization_id IS NOT NULL THEN
    SELECT dp.id, dp.status INTO v_driver_profile_id, v_fleet_driver_status
    FROM public.driver_profiles dp
    WHERE dp.organization_id = v_req.approved_organization_id
      AND dp.user_id = v_req.approved_user_id
    LIMIT 1;
    SELECT count(*)::INT INTO v_fleet_document_count
    FROM public.driver_documents dd
    WHERE dd.organization_id = v_req.approved_organization_id
      AND dd.user_id = v_req.approved_user_id
      AND COALESCE(
        dd.metadata->>'marketplace_participant_request_id',
        dd.metadata->>'marketplace_request_id'
      ) = v_req.id::TEXT;
    SELECT count(*)::INT INTO v_fleet_compliance_event_count
    FROM public.driver_compliance_events dce
    WHERE dce.organization_id = v_req.approved_organization_id
      AND dce.user_id = v_req.approved_user_id
      AND dce.event_type = 'marketplace_driver_approved'
      AND COALESCE(
        dce.payload->>'marketplace_participant_request_id',
        dce.payload->>'marketplace_request_id'
      ) = v_req.id::TEXT;
  END IF;
  v_handoff_ready := v_handoff_ready AND v_driver_profile_id IS NOT NULL;
  RETURN jsonb_strip_nulls(jsonb_build_object(
    'ok', TRUE,
    'status', v_req.status,
    'application_state', v_state,
    'participant_type_key', v_req.requested_participant_type_key,
    'review_decision', v_req.review_decision,
    'reviewed_at', v_req.reviewed_at,
    'invite_email_sent_at', v_req.invite_email_sent_at,
    'invite_redirect_to', v_req.invite_redirect_to,
    'review_reason', v_req.review_reason,
    'requested_documents', v_req.decision_metadata->'requested_documents',
    'profile_handoff', jsonb_build_object(
      'ready', v_handoff_ready,
      'organization_id', v_req.approved_organization_id,
      'user_id', v_req.approved_user_id,
      'participant_profile_id', v_req.approved_participant_profile_id,
      'driver_profile_id', v_driver_profile_id,
      'fleet_driver_status', v_fleet_driver_status,
      'fleet_handoff_ready', v_driver_profile_id IS NOT NULL,
      'fleet_document_count', v_fleet_document_count,
      'fleet_compliance_event_count', v_fleet_compliance_event_count,
      'invite_redirect_to', v_req.invite_redirect_to,
      'invite_email_sent_at', v_req.invite_email_sent_at
    )
  ));
END;
$function$;

REVOKE ALL ON FUNCTION public.marketplace_application_status_by_token_v1(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.marketplace_application_status_by_token_v1(UUID) TO authenticated, service_role;

INSERT INTO public.lookup_definitions(category, description, owner_role, approval_policy, is_mutable)
VALUES ('decision_category', 'Canonical decision categories', 'operations', 'tier_1', FALSE)
ON CONFLICT (category) DO NOTHING;

INSERT INTO public.lookup_values(
  lookup_definition_id, value, label, metadata, sort_order, is_default, status
)
SELECT d.id, 'fleet.driver_assigned', 'Fleet driver assigned', '{}'::jsonb, 920, FALSE, 'active'
FROM public.lookup_definitions d
WHERE d.category = 'decision_category'
ON CONFLICT (lookup_definition_id, value) DO UPDATE
SET label = EXCLUDED.label, metadata = EXCLUDED.metadata, sort_order = EXCLUDED.sort_order,
    status = 'active', updated_at = now();

DO $postcondition$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.lookup_definitions d
    JOIN public.lookup_values v ON v.lookup_definition_id = d.id
    WHERE d.category = 'decision_category'
      AND v.value = 'fleet.driver_assigned'
      AND v.status = 'active'
  ) THEN
    RAISE EXCEPTION 'fleet.driver_assigned decision category is unavailable';
  END IF;
END;
$postcondition$;

-------------------------------------------------------------------------------
-- Webhook policy schema and settings-version convergence.
-------------------------------------------------------------------------------

WITH base AS (
  SELECT schema, description, examples
  FROM public.schema_registry
  WHERE category = 'webhook_ingest_policy' AND version = 2
  LIMIT 1
), patched AS (
  SELECT jsonb_set(
    base.schema,
    '{properties,workflow}',
    jsonb_build_object(
      'type', jsonb_build_array('object', 'null'),
      'additionalProperties', FALSE,
      'properties', jsonb_build_object(
        'template_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
        'template_name', jsonb_build_object('type', 'string', 'minLength', 1),
        'templates_by_intent', jsonb_build_object(
          'type', 'object',
          'additionalProperties', jsonb_build_object(
            'oneOf', jsonb_build_array(
              jsonb_build_object('type', 'string', 'minLength', 1),
              jsonb_build_object(
                'type', 'object',
                'additionalProperties', FALSE,
                'properties', jsonb_build_object(
                  'template_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
                  'template_name', jsonb_build_object('type', 'string', 'minLength', 1)
                )
              )
            )
          )
        ),
        'context_patch', jsonb_build_object('type', jsonb_build_array('object', 'null')),
        'intent', jsonb_build_object('type', 'string'),
        'notes', jsonb_build_object('type', 'string'),
        'launch_mode', jsonb_build_object('enum', jsonb_build_array('in_background', 'sync_only'))
      )
    ), TRUE
  ) AS schema, base.description, base.examples
  FROM base
)
INSERT INTO public.schema_registry(category, version, schema, description, examples, is_active)
SELECT 'webhook_ingest_policy', 3, patched.schema,
       COALESCE(patched.description, 'webhook_ingest_policy schema') || ' (v3: typed workflow intent bindings)',
       patched.examples, TRUE
FROM patched
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema, description = EXCLUDED.description,
    examples = EXCLUDED.examples, is_active = TRUE;

UPDATE public.schema_registry
SET is_active = (version = 3)
WHERE category = 'webhook_ingest_policy';

DO $settings$
DECLARE
  v_setting RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.schema_registry
    WHERE category = 'webhook_ingest_policy' AND version = 3 AND is_active
  ) THEN
    RAISE EXCEPTION 'webhook_ingest_policy schema v3 could not be installed';
  END IF;
  FOR v_setting IN
    SELECT s.scope_type, s.scope_id, COALESCE(s.cached_value, sv.value, '{}'::jsonb) AS value
    FROM public.settings s
    JOIN public.settings_versions sv ON sv.id = s.settings_version_id
    WHERE s.category = 'webhook_ingest_policy'
    FOR UPDATE OF s, sv
  LOOP
    PERFORM 1 FROM public.upsert_settings_value_v1(
      'webhook_ingest_policy', v_setting.scope_type, v_setting.scope_id,
      v_setting.value, 3, 'webhook policy schema v3 convergence'
    );
  END LOOP;
END;
$settings$;

-------------------------------------------------------------------------------
-- Geocoding exactness and fail-closed free-form provider dispatch.
-------------------------------------------------------------------------------

UPDATE public.canonical_cities c
SET name_arabic = U&'\0627\0644\0631\064A\0627\0636',
    province = 'Riyadh',
    alternate_names = ARRAY(
      SELECT DISTINCT value
      FROM unnest(
        COALESCE(c.alternate_names, ARRAY[]::TEXT[])
          || ARRAY['Riyadh', 'Riyadh City', U&'\0627\0644\0631\064A\0627\0636']
      ) AS value
      WHERE btrim(value) <> ''
      ORDER BY value
    ),
    updated_at = now()
WHERE lower(c.name_canonical) = 'riyadh'
  AND upper(c.country_code) = 'SA';

CREATE OR REPLACE FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  p_step workflow_run_steps,
  p_run workflow_runs,
  p_operation_result JSONB DEFAULT '{}'::jsonb
)
RETURNS workflow_handler_response
LANGUAGE plpgsql
SET search_path TO public, workflow_handlers, extensions, pg_temp
AS $function$
DECLARE
  v_metadata JSONB := COALESCE(p_step.metadata, '{}'::jsonb);
  v_policy JSONB := workflow_handlers.geocoding_resolve_policy_for_run(p_run);
  v_attempt_type TEXT := lower(COALESCE(NULLIF(v_metadata->>'attempt_type', ''), 'primary'));
  v_require_fallback BOOLEAN := COALESCE((p_run.context->'geocoding'->>'require_fallback')::BOOLEAN, FALSE);
  v_already_resolved BOOLEAN := COALESCE((p_run.context->'geocoding'->>'successful')::BOOLEAN, FALSE);
  v_provider_candidates TEXT[];
  v_sequence_index INT;
  v_response public.workflow_handler_response;
BEGIN
  PERFORM set_config('search_path', 'public, workflow_handlers, extensions, pg_temp', FALSE);
  IF v_already_resolved AND NOT v_require_fallback THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'geocoding_already_resolved');
    v_response.context_patch := jsonb_build_object('geocoding', jsonb_build_object('provider_dispatch_skipped', TRUE));
    RETURN v_response;
  END IF;
  IF v_attempt_type = 'fallback' AND NOT v_require_fallback THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'fallback_not_required');
    v_response.context_patch := jsonb_build_object('geocoding', jsonb_build_object('fallback_skipped', TRUE));
    RETURN v_response;
  END IF;
  v_provider_candidates := ARRAY(
    SELECT elem::TEXT
    FROM jsonb_array_elements_text(COALESCE(v_policy->'provider_priority', '[]'::jsonb)) AS elem
    WHERE elem::TEXT NOT IN ('internal_cache', 'manual_review_virtual')
  );
  v_sequence_index := COALESCE(NULLIF(v_metadata->>'provider_sequence_index', '')::INT, 0);
  IF array_length(v_provider_candidates, 1) IS NULL THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object('skipped', TRUE, 'reason', 'provider_priority_empty');
    v_response.context_patch := jsonb_build_object('geocoding', jsonb_build_object(
      'successful', FALSE, 'manual_review_required', TRUE,
      'manual_review_reason', 'provider_priority_exhausted'
    ));
    RETURN v_response;
  END IF;
  IF v_sequence_index >= array_length(v_provider_candidates, 1) THEN
    v_response.status := 'completed';
    v_response.operation_result := jsonb_build_object(
      'skipped', TRUE, 'reason', 'provider_priority_exhausted',
      'provider_sequence_index', v_sequence_index
    );
    v_response.context_patch := jsonb_build_object('geocoding', jsonb_build_object(
      'successful', FALSE, 'manual_review_required', TRUE,
      'manual_review_reason', 'provider_priority_exhausted'
    ));
    RETURN v_response;
  END IF;
  BEGIN
    RETURN workflow_handlers.execute_provider_dispatch_v1_base(p_step, p_run, p_operation_result);
  EXCEPTION
    WHEN invalid_text_representation THEN
      -- Free-form legacy address text is valid intake, but not valid JSON. Keep
      -- provider execution fail-closed and route the workflow to manual review.
      v_response.status := 'completed';
      v_response.operation_result := jsonb_build_object(
        'skipped', TRUE, 'reason', 'address_raw_input_not_json'
      );
      v_response.context_patch := jsonb_build_object('geocoding', jsonb_build_object(
        'successful', FALSE,
        'manual_review_required', TRUE,
        'manual_review_reason', 'address_raw_input_not_json'
      ));
      RETURN v_response;
  END;
END;
$function$;

REVOKE ALL ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  workflow_run_steps, workflow_runs, JSONB
) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION workflow_handlers.execute_provider_dispatch_v1(
  workflow_run_steps, workflow_runs, JSONB
) TO service_role;

ALTER FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  RENAME TO geocoding_manual_review_queue_task_sync_v1_base_202608161870;

REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1_base_202608161870(UUID)
  FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION public.geocoding_manual_review_queue_task_sync_v1(
  p_manual_review_task_id UUID
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_review public.manual_review_tasks%ROWTYPE;
  v_shipment public.shipments%ROWTYPE;
  v_shipment_id UUID;
BEGIN
  SELECT * INTO v_review
  FROM public.manual_review_tasks mrt
  WHERE mrt.id = p_manual_review_task_id
  FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  v_shipment_id := COALESCE(
    v_review.shipment_id,
    CASE WHEN lower(COALESCE(v_review.resource_type, '')) = 'shipment' THEN v_review.resource_id END
  );
  IF v_shipment_id IS NOT NULL THEN
    SELECT * INTO v_shipment
    FROM public.shipments sh
    WHERE sh.id = v_shipment_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'manual-review shipment % is unavailable', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.organization_id IS NOT NULL
       AND v_review.organization_id IS DISTINCT FROM v_shipment.organization_id THEN
      RAISE EXCEPTION 'manual-review organization lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.client_id IS NOT NULL
       AND v_review.client_id IS DISTINCT FROM v_shipment.client_id THEN
      RAISE EXCEPTION 'manual-review client lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    IF v_review.sender_id IS NOT NULL
       AND v_review.sender_id IS DISTINCT FROM v_shipment.sender_id THEN
      RAISE EXCEPTION 'manual-review sender lineage conflicts with shipment %', v_shipment_id USING ERRCODE = '23514';
    END IF;
    UPDATE public.manual_review_tasks
    SET organization_id = COALESCE(v_review.organization_id, v_shipment.organization_id),
        client_id = COALESCE(v_review.client_id, v_shipment.client_id),
        sender_id = COALESCE(v_review.sender_id, v_shipment.sender_id),
        shipment_id = COALESCE(v_review.shipment_id, v_shipment.id),
        updated_at = now()
    WHERE id = p_manual_review_task_id;
  END IF;
  RETURN public.geocoding_manual_review_queue_task_sync_v1_base_202608161870(
    p_manual_review_task_id
  );
END;
$function$;

REVOKE ALL ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.geocoding_manual_review_queue_task_sync_v1(UUID)
  TO service_role;

COMMIT;
