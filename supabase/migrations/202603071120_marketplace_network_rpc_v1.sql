-- Plan: PLAN-202603-marketplace-network-v1 / Step: S04
-- Migration: Marketplace network RPC + lifecycle foundation v1
-- Date: 2026-03-07

BEGIN;
SELECT pg_advisory_lock(hashtext('202603071120_marketplace_network_rpc_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

-------------------------------------------------------------------------------
-- 1) Policy defaults + ladder helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_policy_default_v1(
  p_category TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_category TEXT := lower(btrim(COALESCE(p_category, '')));
BEGIN
  CASE v_category
    WHEN 'marketplace_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'curated_network', TRUE,
        'default_visibility_mode', 'private_pool_first',
        'default_pricing_mode', 'quote',
        'default_negotiation_mode', 'counter',
        'default_ownership_mode', 'origin_tenant',
        'default_settlement_mode', 'manual_recorded',
        'default_tracking_display_mode', 'origin_brand_only',
        'default_listing_status', 'curated_network',
        'request_release_order', jsonb_build_array('private_pool', 'curated_network'),
        'provider_tenant_opt_in_requires_review', FALSE,
        'freelancer_multi_tenant_enabled', TRUE,
        'private_pool', jsonb_build_object('enabled', TRUE),
        'ai', jsonb_build_object('advisory_only', TRUE)
      );
    WHEN 'marketplace_request_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'allowed_request_kinds', jsonb_build_array('driver_shift_market', 'capacity_block'),
        'request_defaults', jsonb_build_object(
          'status', 'draft',
          'auto_publish', FALSE,
          'expire_hours', 24
        )
      );
    WHEN 'marketplace_visibility_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'private_pool_first', TRUE,
        'allow_curated_network_release', TRUE,
        'allow_public_release', FALSE
      );
    WHEN 'marketplace_execution_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'work_package_required', TRUE,
        'default_materializer', 'manual_bridge',
        'bridge_mode', 'contract_scoped',
        'allow_direct_transfer', FALSE
      );
    WHEN 'marketplace_settlement_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'record_payables', TRUE,
        'manual_payout_only', TRUE,
        'allow_automatic_payouts', FALSE,
        'reserve_holdback_percent', 0
      );
    WHEN 'marketplace_reputation_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'composite_score', TRUE,
        'weights', jsonb_build_object(
          'completion_rate', 40,
          'cancellation_rate', -25,
          'dispute_rate', -20,
          'document_freshness', 15,
          'feedback_score', 20
        )
      );
    WHEN 'marketplace_tracking_display_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'display_mode', 'origin_brand_only',
        'mask_contact_details', TRUE,
        'show_supplier_identity_to_recipient', FALSE
      );
    WHEN 'marketplace_compliance_policy' THEN
      RETURN jsonb_build_object(
        'version', 1,
        'enabled', TRUE,
        'approval_mode', 'required',
        'turnstile', jsonb_build_object('required', TRUE),
        'rate_limit', jsonb_build_object('window_seconds', 60, 'max_requests', 10),
        'dedupe', jsonb_build_object('window_seconds', 86400),
        'participant_types', jsonb_build_object(
          'freelancer_driver', jsonb_build_object(
            'enabled', TRUE,
            'allow_public_intake', TRUE,
            'default_listing_status', 'curated_network'
          ),
          'provider_tenant', jsonb_build_object(
            'enabled', TRUE,
            'allow_public_intake', FALSE,
            'default_listing_status', 'private'
          )
        ),
        'onboarding', jsonb_build_object(
          'create_lightweight_org', TRUE,
          'initial_user_type', 'driver',
          'initial_role_key', 'driver',
          'invite_redirect_to', NULL
        ),
        'task', jsonb_build_object(
          'enabled', TRUE,
          'organization_slug', 'global-root',
          'task_type_key', 'marketplace_participant_review',
          'queue_key', 'marketplace_participant_review',
          'priority', 45,
          'sla_minutes', 120
        )
      );
    ELSE
      RETURN '{}'::jsonb;
  END CASE;
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_policy_lookup_v1(
  p_category TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_default JSONB := public.marketplace_policy_default_v1(p_category);
BEGIN
  RETURN QUERY
  WITH resolved AS (
    SELECT *
      FROM public.resolve_settings_row_from_policy_context_v1(
        p_category,
        COALESCE(p_context, '{}'::jsonb)
      )
     LIMIT 1
  )
  SELECT
    resolved.settings_id,
    resolved.settings_version_id,
    resolved.scope_type,
    resolved.scope_id,
    public.jsonb_deep_merge(v_default, COALESCE(resolved.value, '{}'::jsonb)) AS value,
    COALESCE(resolved.version, 1) AS version,
    COALESCE(resolved.scope_path, '[]'::jsonb) AS scope_path
  FROM resolved
  UNION ALL
  SELECT
    NULL::uuid,
    NULL::uuid,
    'global'::text,
    NULL::uuid,
    v_default,
    1,
    jsonb_build_array(jsonb_build_object('scope_type', 'global', 'scope_id', NULL))
  WHERE NOT EXISTS (
    SELECT 1
      FROM public.resolve_settings_row_from_policy_context_v1(
        p_category,
        COALESCE(p_context, '{}'::jsonb)
      )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_resolve_policy_row_v1(
  p_category TEXT,
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS TABLE (
  settings_resolution_id UUID,
  settings_id UUID,
  settings_version_id UUID,
  scope_type TEXT,
  scope_id UUID,
  value JSONB,
  version INT,
  scope_path JSONB
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_row RECORD;
  v_log_org_id UUID := public.marketplace_system_org_id_v1();
BEGIN
  BEGIN
    v_log_org_id := COALESCE(
      NULLIF(COALESCE(p_context->>'organization_id', ''), '')::uuid,
      public.current_user_org_id(),
      public.marketplace_system_org_id_v1()
    );
  EXCEPTION
    WHEN others THEN
      v_log_org_id := COALESCE(public.current_user_org_id(), public.marketplace_system_org_id_v1());
  END;

  SELECT *
    INTO v_row
    FROM public.marketplace_policy_lookup_v1(p_category, p_context)
   LIMIT 1;

  settings_resolution_id := public.log_settings_resolution(
    p_organization_id := COALESCE(v_log_org_id, public.marketplace_system_org_id_v1()),
    p_category := p_category,
    p_winning_scope_type := COALESCE(v_row.scope_type, 'global'),
    p_winning_scope_id := v_row.scope_id,
    p_winning_settings_id := v_row.settings_id,
    p_winning_settings_version_id := v_row.settings_version_id,
    p_winning_version := COALESCE(v_row.version, 1),
    p_scope_path := COALESCE(v_row.scope_path, '[]'::jsonb),
    p_inputs := COALESCE(p_context, '{}'::jsonb),
    p_merge_notes := jsonb_build_object('resolver', 'marketplace_resolve_policy_row_v1')
  );
  settings_id := v_row.settings_id;
  settings_version_id := v_row.settings_version_id;
  scope_type := COALESCE(v_row.scope_type, 'global');
  scope_id := v_row.scope_id;
  value := COALESCE(v_row.value, '{}'::jsonb);
  version := COALESCE(v_row.version, 1);
  scope_path := COALESCE(v_row.scope_path, '[]'::jsonb);

  RETURN NEXT;
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_request_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_visibility_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_visibility_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_execution_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_execution_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_settlement_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_settlement_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_reputation_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_reputation_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_tracking_display_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_tracking_display_policy', p_context)
   LIMIT 1;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_compliance_policy_v1(
  p_context JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT value
    FROM public.marketplace_policy_lookup_v1('marketplace_compliance_policy', p_context)
   LIMIT 1;
$function$;

-------------------------------------------------------------------------------
-- 2) Read helpers + immutable event helpers
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_request_kind_catalog_v1(
  p_context JSONB DEFAULT '{}'::jsonb,
  p_include_inactive BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_marketplace_policy JSONB := public.marketplace_policy_v1(p_context);
  v_request_policy JSONB := public.marketplace_request_policy_v1(p_context);
  v_compliance_policy JSONB := public.marketplace_compliance_policy_v1(p_context);
  v_items JSONB := '[]'::jsonb;
BEGIN
  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'kind_key', rk.kind_key,
               'label', rk.label,
               'description', rk.description,
               'participant_type_supply_key', rk.participant_type_supply_key,
               'payload_schema_category', rk.payload_schema_category,
               'payload_schema', sr.schema,
               'default_materializer_key', rk.default_materializer_key,
               'is_active', rk.is_active,
               'is_public', rk.is_public,
               'ui_config', rk.ui_config,
               'lifecycle_config', rk.lifecycle_config,
               'metadata', rk.metadata
             )
             ORDER BY rk.kind_key
           ),
           '[]'::jsonb
         )
    INTO v_items
    FROM public.marketplace_request_kinds rk
    LEFT JOIN public.schema_registry sr
      ON sr.category = rk.payload_schema_category
     AND sr.is_active = TRUE
   WHERE p_include_inactive
      OR rk.is_active = TRUE;

  RETURN jsonb_build_object(
    'request_kinds', v_items,
    'marketplace_policy', v_marketplace_policy,
    'request_policy', v_request_policy,
    'compliance_policy', v_compliance_policy,
    'offer_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_offer_terms'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'contract_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_contract_terms'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'onboarding_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_onboarding_form'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    ),
    'verification_schema', (
      SELECT sr.schema
        FROM public.schema_registry sr
       WHERE sr.category = 'marketplace_verification_requirements'
         AND sr.is_active = TRUE
       ORDER BY sr.version DESC
       LIMIT 1
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_append_event_v1(
  p_organization_id UUID,
  p_resource_type TEXT,
  p_resource_id UUID DEFAULT NULL,
  p_event_type TEXT DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb,
  p_correlation_id UUID DEFAULT NULL
)
RETURNS UUID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_id UUID := gen_random_uuid();
BEGIN
  IF p_organization_id IS NULL THEN
    RAISE EXCEPTION 'marketplace_append_event_v1 requires organization_id';
  END IF;

  INSERT INTO public.marketplace_events (
    id,
    organization_id,
    actor_user_id,
    resource_type,
    resource_id,
    event_type,
    correlation_id,
    payload
  )
  VALUES (
    v_id,
    p_organization_id,
    auth.uid(),
    COALESCE(NULLIF(btrim(COALESCE(p_resource_type, '')), ''), 'marketplace'),
    p_resource_id,
    COALESCE(NULLIF(btrim(COALESCE(p_event_type, '')), ''), 'event'),
    p_correlation_id,
    COALESCE(p_payload, '{}'::jsonb)
  );

  RETURN v_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_refresh_reputation_snapshot_v1(
  p_participant_profile_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID;
  v_score NUMERIC(10,2) := 0;
  v_event_count INTEGER := 0;
  v_completion_rate NUMERIC(10,4) := 0;
  v_cancellation_rate NUMERIC(10,4) := 0;
  v_dispute_rate NUMERIC(10,4) := 0;
  v_document_freshness NUMERIC(10,4) := 0;
  v_feedback_score NUMERIC(10,4) := 0;
  v_snapshot JSONB;
BEGIN
  SELECT p.organization_id
    INTO v_org_id
    FROM public.marketplace_participant_profiles p
   WHERE p.id = p_participant_profile_id
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_not_found'));
  END IF;

  SELECT
    COALESCE(SUM(score_delta * weight), 0),
    COUNT(*),
    COALESCE(AVG(CASE WHEN metric_key = 'completion_rate' THEN score_delta END), 0),
    COALESCE(ABS(AVG(CASE WHEN metric_key = 'cancellation_rate' THEN score_delta END)), 0),
    COALESCE(ABS(AVG(CASE WHEN metric_key = 'dispute_rate' THEN score_delta END)), 0),
    COALESCE(AVG(CASE WHEN metric_key = 'document_freshness' THEN score_delta END), 0),
    COALESCE(AVG(CASE WHEN metric_key = 'feedback_score' THEN score_delta END), 0)
    INTO
      v_score,
      v_event_count,
      v_completion_rate,
      v_cancellation_rate,
      v_dispute_rate,
      v_document_freshness,
      v_feedback_score
    FROM public.marketplace_reputation_events e
   WHERE e.participant_profile_id = p_participant_profile_id;

  v_snapshot := jsonb_build_object(
    'score', v_score,
    'event_count', v_event_count,
    'completion_rate', v_completion_rate,
    'cancellation_rate', v_cancellation_rate,
    'dispute_rate', v_dispute_rate,
    'document_freshness', v_document_freshness,
    'feedback_score', v_feedback_score
  );

  INSERT INTO public.marketplace_reputation_snapshots (
    participant_profile_id,
    organization_id,
    score,
    event_count,
    completion_rate,
    cancellation_rate,
    dispute_rate,
    document_freshness,
    feedback_score,
    snapshot,
    created_at,
    updated_at
  )
  VALUES (
    p_participant_profile_id,
    v_org_id,
    v_score,
    v_event_count,
    v_completion_rate,
    v_cancellation_rate,
    v_dispute_rate,
    v_document_freshness,
    v_feedback_score,
    v_snapshot,
    now(),
    now()
  )
  ON CONFLICT (participant_profile_id) DO UPDATE
  SET
    organization_id = EXCLUDED.organization_id,
    score = EXCLUDED.score,
    event_count = EXCLUDED.event_count,
    completion_rate = EXCLUDED.completion_rate,
    cancellation_rate = EXCLUDED.cancellation_rate,
    dispute_rate = EXCLUDED.dispute_rate,
    document_freshness = EXCLUDED.document_freshness,
    feedback_score = EXCLUDED.feedback_score,
    snapshot = EXCLUDED.snapshot,
    updated_at = now();

  UPDATE public.marketplace_participant_profiles
     SET rating_overall = v_score,
         rating_count = v_event_count,
         updated_at = now()
   WHERE id = p_participant_profile_id;

  RETURN jsonb_build_object('ok', TRUE, 'participant_profile_id', p_participant_profile_id, 'snapshot', v_snapshot);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_append_reputation_event_v1(
  p_participant_profile_id UUID,
  p_event_type TEXT,
  p_metric_key TEXT,
  p_score_delta NUMERIC DEFAULT 0,
  p_weight NUMERIC DEFAULT 1,
  p_subject_resource_type TEXT DEFAULT NULL,
  p_subject_resource_id UUID DEFAULT NULL,
  p_payload JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT p.organization_id
    INTO v_org_id
    FROM public.marketplace_participant_profiles p
   WHERE p.id = p_participant_profile_id
   LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_not_found'));
  END IF;

  INSERT INTO public.marketplace_reputation_events (
    participant_profile_id,
    organization_id,
    event_type,
    metric_key,
    weight,
    score_delta,
    subject_resource_type,
    subject_resource_id,
    payload
  )
  VALUES (
    p_participant_profile_id,
    v_org_id,
    COALESCE(NULLIF(btrim(COALESCE(p_event_type, '')), ''), 'metric'),
    COALESCE(NULLIF(btrim(COALESCE(p_metric_key, '')), ''), 'general'),
    COALESCE(p_weight, 1),
    COALESCE(p_score_delta, 0),
    NULLIF(btrim(COALESCE(p_subject_resource_type, '')), ''),
    p_subject_resource_id,
    COALESCE(p_payload, '{}'::jsonb)
  );

  RETURN public.marketplace_refresh_reputation_snapshot_v1(p_participant_profile_id);
END;
$function$;

-------------------------------------------------------------------------------
-- 3) Participant onboarding + review
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_assert_reviewer_v1()
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'platform_scope_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_participant_requests.review', 'global', NULL);

  RETURN jsonb_build_object(
    'user_id', auth.uid(),
    'organization_id', public.current_user_org_id(),
    'scope_type', public.current_user_scope_type(),
    'scope_id', public.current_user_scope_id()
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_record_error_v1(
  p_request_id UUID,
  p_error_code TEXT,
  p_error_message TEXT,
  p_error_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
BEGIN
  UPDATE public.marketplace_participant_requests
     SET last_error_code = NULLIF(btrim(COALESCE(p_error_code, '')), ''),
         last_error_message = NULLIF(btrim(COALESCE(p_error_message, '')), ''),
         last_error_at = now(),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || jsonb_build_object(
             'last_error', jsonb_build_object(
               'code', NULLIF(btrim(COALESCE(p_error_code, '')), ''),
               'message', NULLIF(btrim(COALESCE(p_error_message, '')), ''),
               'metadata', COALESCE(p_error_metadata, '{}'::jsonb),
               'at', now()
             )
           ),
         updated_at = now()
   WHERE id = p_request_id;
END;
$function$;

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
  v_full_name TEXT := btrim(COALESCE(p_full_name, ''));
  v_org_name TEXT := btrim(COALESCE(p_organization_name, ''));
  v_org_slug TEXT := NULLIF(btrim(COALESCE(p_organization_slug, '')), '');
  v_ip_hash TEXT := NULLIF(btrim(COALESCE(p_ip_hash, '')), '');
  v_now TIMESTAMPTZ := now();
  v_policy JSONB;
  v_enabled BOOLEAN;
  v_turnstile_required BOOLEAN;
  v_window_seconds INT;
  v_max_requests INT;
  v_dedupe_seconds INT;
  v_allow_public_intake BOOLEAN := FALSE;
  v_recent_count INT := 0;
  v_existing RECORD;
  v_request_id UUID := gen_random_uuid();
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
  v_policy := public.marketplace_compliance_policy_v1(
    jsonb_build_object(
      'organization_id', p_requested_organization_id,
      'participant_type_key', v_type_key
    )
  );

  v_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['enabled'], FALSE);
  IF NOT v_enabled THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'disabled'));
  END IF;

  v_allow_public_intake := public.tenant_signup_policy_bool_v1(
    v_policy,
    ARRAY['participant_types', v_type_key, 'allow_public_intake'],
    FALSE
  );
  IF NOT v_allow_public_intake AND p_requested_organization_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'public_intake_not_allowed'));
  END IF;

  v_turnstile_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['turnstile', 'required'], TRUE);
  IF v_turnstile_required AND NOT COALESCE(p_turnstile_verified, FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'turnstile_required'));
  END IF;

  IF v_type_key = '' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_required'));
  END IF;

  IF NOT EXISTS (
    SELECT 1
      FROM public.marketplace_registry_entries e
     WHERE e.registry_type = 'participant_type'
       AND e.entry_key = v_type_key
       AND e.is_active = TRUE
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

  v_window_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'window_seconds'], 60, 1, 86400);
  v_max_requests := public.tenant_signup_policy_int_v1(v_policy, ARRAY['rate_limit', 'max_requests'], 10, 0, 100000);
  v_dedupe_seconds := public.tenant_signup_policy_int_v1(v_policy, ARRAY['dedupe', 'window_seconds'], 86400, 0, 31536000);

  IF v_ip_hash IS NOT NULL AND v_max_requests > 0 THEN
    SELECT COUNT(*)
      INTO v_recent_count
      FROM public.marketplace_participant_requests r
     WHERE r.ip_hash = v_ip_hash
       AND r.created_at >= (v_now - (v_window_seconds || ' seconds')::interval);

    IF v_recent_count >= v_max_requests THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'rate_limited'));
    END IF;
  END IF;

  IF v_dedupe_seconds > 0 THEN
    SELECT r.*
      INTO v_existing
      FROM public.marketplace_participant_requests r
     WHERE lower(r.email) = v_email
       AND r.requested_participant_type_key = v_type_key
       AND r.created_at >= (v_now - (v_dedupe_seconds || ' seconds')::interval)
     ORDER BY r.created_at DESC
     LIMIT 1;

    IF v_existing.id IS NOT NULL THEN
      RETURN jsonb_build_object(
        'ok', TRUE,
        'id', v_existing.id,
        'status', v_existing.status,
        'deduped', TRUE
      );
    END IF;
  END IF;

  INSERT INTO public.marketplace_participant_requests (
    id,
    status,
    requested_participant_type_key,
    requested_by_user_id,
    requested_organization_id,
    email,
    full_name,
    organization_name,
    organization_slug,
    phone,
    website_url,
    locale,
    page_url,
    referrer,
    origin,
    experience_summary,
    capabilities_requested,
    verification_documents,
    marketing,
    metadata,
    ip_hash,
    turnstile_verified
  )
  VALUES (
    v_request_id,
    'pending',
    v_type_key,
    p_requested_by_user_id,
    p_requested_organization_id,
    v_email,
    v_full_name,
    v_org_name,
    v_org_slug,
    NULLIF(btrim(COALESCE(p_phone, '')), ''),
    NULLIF(btrim(COALESCE(p_website_url, '')), ''),
    NULLIF(btrim(COALESCE(p_locale, '')), ''),
    NULLIF(btrim(COALESCE(p_page_url, '')), ''),
    NULLIF(btrim(COALESCE(p_referrer, '')), ''),
    NULLIF(btrim(COALESCE(p_origin, '')), ''),
    NULLIF(btrim(COALESCE(p_experience_summary, '')), ''),
    CASE WHEN jsonb_typeof(p_capabilities_requested) = 'array' THEN p_capabilities_requested ELSE '[]'::jsonb END,
    CASE WHEN jsonb_typeof(p_verification_documents) = 'array' THEN p_verification_documents ELSE '[]'::jsonb END,
    COALESCE(p_marketing, '{}'::jsonb),
    COALESCE(p_metadata, '{}'::jsonb),
    v_ip_hash,
    COALESCE(p_turnstile_verified, FALSE)
  );

  v_task_enabled := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['task', 'enabled'], TRUE);
  v_task_org_slug := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'organization_slug'], ''), 'global-root');
  v_task_type_key := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'task_type_key'], ''), 'marketplace_participant_review');
  v_task_queue := COALESCE(NULLIF(v_policy #>> ARRAY['task', 'queue_key'], ''), 'marketplace_participant_review');
  v_task_priority := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'priority'], 45, 0, 1000);
  v_task_sla_minutes := public.tenant_signup_policy_int_v1(v_policy, ARRAY['task', 'sla_minutes'], 120, 0, 10080);

  IF v_task_enabled THEN
    SELECT o.id
      INTO v_task_org_id
      FROM public.organizations o
     WHERE o.slug = v_task_org_slug
     LIMIT 1;

    IF v_task_org_id IS NOT NULL THEN
      BEGIN
        SELECT t.task_id, t.workflow_run_id
          INTO v_task_id, v_workflow_run_id
          FROM public.create_task_system_v1(
            jsonb_build_object(
              'task_type_key', v_task_type_key,
              'context', jsonb_build_object(
                'marketplace_participant_request_id', v_request_id,
                'requested_participant_type_key', v_type_key,
                'requested_organization_id', p_requested_organization_id
              ),
              'resource_type', 'marketplace_participant_request',
              'resource_id', v_request_id,
              'queue_key', v_task_queue,
              'priority', v_task_priority,
              'sla_minutes', v_task_sla_minutes,
              'idempotency_key', 'marketplace-participant-request:' || v_request_id::text,
              'metadata', jsonb_build_object(
                'organization_id', v_task_org_id,
                'source', 'marketplace_participant_request_create_v1'
              ),
              'actor_system', 'marketplace_participant_request_create_v1'
            )
          ) AS t;
      EXCEPTION
        WHEN others THEN
          PERFORM public.marketplace_participant_request_record_error_v1(
            v_request_id,
            'task_create_failed',
            SQLERRM,
            jsonb_build_object('sqlstate', SQLSTATE)
          );
      END;
    END IF;
  END IF;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(p_requested_organization_id, public.marketplace_system_org_id_v1()),
    'marketplace_participant_request',
    v_request_id,
    'participant_request.created',
    jsonb_build_object(
      'requested_participant_type_key', v_type_key,
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_request_id,
      'status', 'pending',
      'task_id', v_task_id,
      'workflow_run_id', v_workflow_run_id
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_apply_participant_request_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_approved_organization_id UUID DEFAULT NULL,
  p_approved_user_id UUID DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_claims JSONB := NULL;
  v_role TEXT := NULL;
  v_decision TEXT := lower(btrim(COALESCE(p_decision, '')));
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_policy JSONB;
  v_listing_status TEXT := 'curated_network';
  v_create_lightweight_org BOOLEAN := TRUE;
  v_user_type TEXT := 'driver';
  v_role_key TEXT := 'driver';
  v_org_id UUID := NULL;
  v_user_id UUID := NULL;
  v_profile_id UUID := NULL;
  v_doc JSONB;
  v_capability TEXT;
  v_document_type TEXT;
  v_document_ref TEXT;
  v_review_resolution_id UUID := NULL;
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
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'service_role_required'));
  END IF;

  IF v_decision = 'approve' THEN
    v_decision := 'approved';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  END IF;

  IF p_request_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_id_required'));
  END IF;

  IF v_decision NOT IN ('approved', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_decision'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests
   WHERE id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status <> 'pending' THEN
    RETURN jsonb_strip_nulls(
      jsonb_build_object(
        'ok', TRUE,
        'id', v_req.id,
        'status', v_req.status,
        'approved_organization_id', v_req.approved_organization_id,
        'approved_user_id', v_req.approved_user_id,
        'approved_participant_profile_id', v_req.approved_participant_profile_id,
        'already_processed', TRUE
      )
    );
  END IF;

  v_policy := public.marketplace_compliance_policy_v1(
    jsonb_build_object(
      'organization_id', COALESCE(v_req.requested_organization_id, p_approved_organization_id),
      'participant_type_key', v_req.requested_participant_type_key
    )
  );
  v_listing_status := COALESCE(
    NULLIF(v_policy #>> ARRAY['participant_types', v_req.requested_participant_type_key, 'default_listing_status'], ''),
    'curated_network'
  );
  v_create_lightweight_org := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['onboarding', 'create_lightweight_org'], TRUE);
  v_user_type := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_user_type']), ''), 'driver'));
  v_role_key := lower(COALESCE(NULLIF(btrim(v_policy #>> ARRAY['onboarding', 'initial_role_key']), ''), v_user_type));

  SELECT settings_resolution_id
    INTO v_review_resolution_id
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_compliance_policy',
      jsonb_build_object(
        'organization_id', COALESCE(v_req.requested_organization_id, p_approved_organization_id),
        'participant_type_key', v_req.requested_participant_type_key
      )
    )
   LIMIT 1;

  IF v_decision = 'rejected' THEN
    UPDATE public.marketplace_participant_requests
       SET status = 'rejected',
           review_decision = 'rejected',
           reviewed_at = now(),
           reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
           review_reason = COALESCE(p_decision_metadata->>'reason', review_reason),
           decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
             || COALESCE(p_decision_metadata, '{}'::jsonb)
             || jsonb_build_object('decision', 'rejected', 'review_applied_at', now()),
           updated_at = now()
     WHERE id = v_req.id;

    PERFORM public.log_decision(
      p_organization_id := COALESCE(v_req.requested_organization_id, public.marketplace_system_org_id_v1()),
      p_decision_category := 'marketplace_compliance_policy',
      p_resource_type := 'marketplace_participant_request',
      p_resource_id := v_req.id,
      p_decision_point := 'participant_request.review',
      p_decision_outcome := 'rejected',
      p_performed_by_system := 'marketplace_apply_participant_request_v1',
      p_decision_inputs := COALESCE(p_decision_metadata, '{}'::jsonb),
      p_decision_reason := COALESCE(p_decision_metadata->>'reason', 'review_rejected'),
      p_settings_resolution_id := v_review_resolution_id
    );

    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'rejected');
  END IF;

  IF v_req.requested_participant_type_key = 'freelancer_driver' AND p_invited_auth_user_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invited_auth_user_required'));
  END IF;

  BEGIN
    IF v_req.requested_participant_type_key = 'provider_tenant' THEN
      v_org_id := COALESCE(v_req.requested_organization_id, p_approved_organization_id);
      v_user_id := COALESCE(v_req.requested_by_user_id, p_approved_user_id, p_invited_auth_user_id);
      IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'approved_organization_required'));
      END IF;
    ELSE
      v_org_id := COALESCE(v_req.approved_organization_id, p_approved_organization_id);

      IF v_org_id IS NULL AND v_create_lightweight_org THEN
        INSERT INTO public.organizations (
          name,
          slug
        )
        VALUES (
          v_req.organization_name,
          public.tenant_signup_next_org_slug_v1(v_req.organization_slug, v_req.organization_name)
        )
        RETURNING id INTO v_org_id;
      END IF;

      IF v_org_id IS NULL THEN
        RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'organization_provision_required'));
      END IF;

      INSERT INTO public.users (
        id,
        organization_id,
        email,
        full_name,
        user_type,
        status,
        access_scope_type,
        access_scope_id
      )
      VALUES (
        p_invited_auth_user_id,
        v_org_id,
        v_req.email,
        COALESCE(NULLIF(v_req.full_name, ''), v_req.email),
        v_user_type,
        'active',
        'tenant',
        NULL
      )
      ON CONFLICT (id) DO UPDATE
      SET
        organization_id = EXCLUDED.organization_id,
        email = EXCLUDED.email,
        full_name = EXCLUDED.full_name,
        user_type = EXCLUDED.user_type,
        status = EXCLUDED.status,
        access_scope_type = EXCLUDED.access_scope_type,
        access_scope_id = EXCLUDED.access_scope_id
      RETURNING id INTO v_user_id;

      PERFORM public.provision_rbac_roles_from_templates_v1(
        v_org_id,
        ARRAY[v_role_key],
        NULL
      );
    END IF;

    INSERT INTO public.marketplace_participant_profiles (
      organization_id,
      participant_type_key,
      status,
      listing_status,
      compliance_state,
      display_name,
      legal_name,
      contact_email,
      contact_phone,
      locale,
      timezone,
      network_metadata,
      profile,
      last_verified_at
    )
    VALUES (
      v_org_id,
      v_req.requested_participant_type_key,
      'approved',
      v_listing_status,
      'approved',
      COALESCE(NULLIF(v_req.full_name, ''), v_req.organization_name),
      v_req.organization_name,
      v_req.email,
      v_req.phone,
      v_req.locale,
      NULL,
      jsonb_build_object(
        'approved_via_request_id', v_req.id,
        'invite_email_sent', COALESCE(p_invite_email_sent, FALSE)
      ),
      jsonb_build_object(
        'experience_summary', v_req.experience_summary,
        'website_url', v_req.website_url
      ),
      now()
    )
    ON CONFLICT (organization_id) DO UPDATE
    SET
      participant_type_key = EXCLUDED.participant_type_key,
      status = 'approved',
      listing_status = EXCLUDED.listing_status,
      compliance_state = 'approved',
      display_name = EXCLUDED.display_name,
      legal_name = EXCLUDED.legal_name,
      contact_email = EXCLUDED.contact_email,
      contact_phone = EXCLUDED.contact_phone,
      locale = EXCLUDED.locale,
      network_metadata = COALESCE(public.marketplace_participant_profiles.network_metadata, '{}'::jsonb)
        || EXCLUDED.network_metadata,
      profile = COALESCE(public.marketplace_participant_profiles.profile, '{}'::jsonb)
        || EXCLUDED.profile,
      last_verified_at = now(),
      suspended_at = NULL,
      updated_at = now()
    RETURNING id INTO v_profile_id;

    IF v_user_id IS NOT NULL THEN
      INSERT INTO public.marketplace_participant_memberships (
        participant_profile_id,
        user_id,
        membership_role,
        status,
        is_primary,
        metadata
      )
      VALUES (
        v_profile_id,
        v_user_id,
        'owner',
        'active',
        TRUE,
        jsonb_build_object('source_request_id', v_req.id)
      )
      ON CONFLICT (participant_profile_id, user_id) DO UPDATE
      SET
        membership_role = EXCLUDED.membership_role,
        status = 'active',
        is_primary = TRUE,
        metadata = COALESCE(public.marketplace_participant_memberships.metadata, '{}'::jsonb)
          || EXCLUDED.metadata,
        updated_at = now();
    END IF;

    FOR v_capability IN
      SELECT value
        FROM jsonb_array_elements_text(
          CASE
            WHEN jsonb_typeof(v_req.capabilities_requested) = 'array' THEN v_req.capabilities_requested
            ELSE '[]'::jsonb
          END
        ) AS capability(value)
    LOOP
      IF btrim(COALESCE(v_capability, '')) = '' THEN
        CONTINUE;
      END IF;

      INSERT INTO public.marketplace_participant_capabilities (
        participant_profile_id,
        capability_key,
        status,
        source_request_id,
        evidence,
        metadata
      )
      VALUES (
        v_profile_id,
        lower(btrim(v_capability)),
        'active',
        v_req.id,
        '{}'::jsonb,
        jsonb_build_object('approved_via_request_id', v_req.id)
      )
      ON CONFLICT (participant_profile_id, capability_key) DO UPDATE
      SET
        status = 'active',
        source_request_id = EXCLUDED.source_request_id,
        metadata = COALESCE(public.marketplace_participant_capabilities.metadata, '{}'::jsonb)
          || EXCLUDED.metadata,
        updated_at = now();
    END LOOP;

    FOR v_doc IN
      SELECT value
        FROM jsonb_array_elements(
          CASE
            WHEN jsonb_typeof(v_req.verification_documents) = 'array' THEN v_req.verification_documents
            ELSE '[]'::jsonb
          END
        ) AS doc(value)
    LOOP
      v_document_type := NULLIF(btrim(COALESCE(v_doc->>'document_type_key', '')), '');
      IF v_document_type IS NULL THEN
        CONTINUE;
      END IF;

      v_document_ref := NULLIF(btrim(COALESCE(v_doc->>'document_ref', '')), '');

      INSERT INTO public.marketplace_verification_records (
        participant_profile_id,
        document_type_key,
        status,
        document_ref,
        issued_at,
        expires_at,
        reviewed_at,
        reviewed_by,
        reviewer_notes,
        evidence,
        metadata
      )
      VALUES (
        v_profile_id,
        lower(v_document_type),
        COALESCE(NULLIF(btrim(COALESCE(v_doc->>'status', '')), ''), 'approved'),
        v_document_ref,
        NULLIF(v_doc->>'issued_at', '')::timestamptz,
        NULLIF(v_doc->>'expires_at', '')::timestamptz,
        now(),
        p_reviewer_user_id,
        NULLIF(btrim(COALESCE(v_doc->>'reviewer_notes', '')), ''),
        COALESCE(v_doc->'evidence', '{}'::jsonb),
        jsonb_build_object('approved_via_request_id', v_req.id)
      );
    END LOOP;
  EXCEPTION
    WHEN others THEN
      PERFORM public.marketplace_participant_request_record_error_v1(
        v_req.id,
        'provision_failed',
        SQLERRM,
        jsonb_build_object('sqlstate', SQLSTATE, 'decision', v_decision)
      );
      RETURN jsonb_build_object(
        'ok', FALSE,
        'error', jsonb_build_object('code', 'provision_failed', 'message', SQLERRM, 'sqlstate', SQLSTATE)
      );
  END;

  UPDATE public.marketplace_participant_requests
     SET status = 'approved',
         review_decision = 'approved',
         reviewed_at = now(),
         reviewed_by = COALESCE(p_reviewer_user_id, reviewed_by),
         review_reason = COALESCE(p_decision_metadata->>'reason', review_reason),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || COALESCE(p_decision_metadata, '{}'::jsonb)
           || jsonb_build_object(
             'decision', 'approved',
             'review_applied_at', now(),
             'invite_email_sent', COALESCE(p_invite_email_sent, FALSE)
           ),
         approved_organization_id = v_org_id,
         approved_user_id = COALESCE(v_user_id, p_approved_user_id),
         approved_auth_user_id = COALESCE(p_invited_auth_user_id, approved_auth_user_id),
         approved_participant_profile_id = v_profile_id,
         invite_email_sent_at = CASE WHEN COALESCE(p_invite_email_sent, FALSE) THEN now() ELSE invite_email_sent_at END,
         invite_redirect_to = COALESCE(NULLIF(btrim(COALESCE(p_invite_redirect_to, '')), ''), invite_redirect_to),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.log_decision(
    p_organization_id := COALESCE(v_org_id, public.marketplace_system_org_id_v1()),
    p_decision_category := 'marketplace_compliance_policy',
    p_resource_type := 'marketplace_participant_request',
    p_resource_id := v_req.id,
    p_decision_point := 'participant_request.review',
    p_decision_outcome := 'approved',
    p_performed_by_system := 'marketplace_apply_participant_request_v1',
    p_decision_inputs := COALESCE(p_decision_metadata, '{}'::jsonb),
    p_decision_reason := COALESCE(p_decision_metadata->>'reason', 'review_approved'),
    p_settings_resolution_id := v_review_resolution_id
  );

  PERFORM public.marketplace_append_event_v1(
    COALESCE(v_org_id, public.marketplace_system_org_id_v1()),
    'marketplace_participant_request',
    v_req.id,
    'participant_request.approved',
    jsonb_build_object(
      'participant_profile_id', v_profile_id,
      'participant_type_key', v_req.requested_participant_type_key
    )
  );

  RETURN jsonb_strip_nulls(
    jsonb_build_object(
      'ok', TRUE,
      'id', v_req.id,
      'status', 'approved',
      'approved_organization_id', v_org_id,
      'approved_user_id', v_user_id,
      'approved_participant_profile_id', v_profile_id
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_participant_request_review_apply_v1(
  p_request_id UUID,
  p_decision TEXT,
  p_reviewer_user_id UUID DEFAULT NULL,
  p_invited_auth_user_id UUID DEFAULT NULL,
  p_invite_email_sent BOOLEAN DEFAULT FALSE,
  p_invite_redirect_to TEXT DEFAULT NULL,
  p_approved_organization_id UUID DEFAULT NULL,
  p_approved_user_id UUID DEFAULT NULL,
  p_decision_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE sql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.marketplace_apply_participant_request_v1(
    p_request_id,
    p_decision,
    p_reviewer_user_id,
    p_invited_auth_user_id,
    p_invite_email_sent,
    p_invite_redirect_to,
    p_approved_organization_id,
    p_approved_user_id,
    p_decision_metadata
  );
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_provider_opt_in_v1(
  p_display_name TEXT DEFAULT NULL,
  p_profile JSONB DEFAULT '{}'::jsonb,
  p_capabilities JSONB DEFAULT '[]'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_user_id UUID := auth.uid();
  v_policy JSONB;
  v_review_required BOOLEAN := FALSE;
  v_profile_id UUID := NULL;
  v_display_name TEXT;
  v_request_id UUID := NULL;
  v_user RECORD;
  v_org RECORD;
  v_capability TEXT;
BEGIN
  IF v_org_id IS NULL OR v_user_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_participants.write', 'tenant', v_org_id);

  SELECT *
    INTO v_user
    FROM public.users u
   WHERE u.id = v_user_id
   LIMIT 1;

  SELECT *
    INTO v_org
    FROM public.organizations o
   WHERE o.id = v_org_id
   LIMIT 1;

  v_policy := public.marketplace_policy_v1(jsonb_build_object('organization_id', v_org_id));
  v_review_required := public.tenant_signup_policy_bool_v1(v_policy, ARRAY['provider_tenant_opt_in_requires_review'], FALSE);
  v_display_name := COALESCE(NULLIF(btrim(COALESCE(p_display_name, '')), ''), NULLIF(btrim(COALESCE(v_org.name, '')), ''), 'Provider tenant');

  IF v_review_required THEN
    SELECT (public.marketplace_participant_request_create_v1(
      p_requested_participant_type_key := 'provider_tenant',
      p_email := COALESCE(v_user.email, ''),
      p_full_name := COALESCE(v_user.full_name, v_display_name),
      p_organization_name := COALESCE(v_org.name, v_display_name),
      p_organization_slug := v_org.slug,
      p_phone := NULL,
      p_website_url := NULL,
      p_locale := NULL,
      p_page_url := NULL,
      p_referrer := NULL,
      p_origin := NULL,
      p_experience_summary := NULL,
      p_capabilities_requested := COALESCE(p_capabilities, '[]'::jsonb),
      p_verification_documents := '[]'::jsonb,
      p_marketing := '{}'::jsonb,
      p_metadata := jsonb_build_object('source', 'marketplace_provider_opt_in_v1'),
      p_requested_organization_id := v_org_id,
      p_requested_by_user_id := v_user_id,
      p_ip_hash := NULL,
      p_turnstile_verified := TRUE
    )->>'id')::uuid INTO v_request_id;

    RETURN jsonb_build_object(
      'ok', TRUE,
      'status', 'pending',
      'request_id', v_request_id
    );
  END IF;

  INSERT INTO public.marketplace_participant_profiles (
    organization_id,
    participant_type_key,
    status,
    listing_status,
    compliance_state,
    display_name,
    legal_name,
    contact_email,
    network_metadata,
    profile,
    last_verified_at
  )
  VALUES (
    v_org_id,
    'provider_tenant',
    'approved',
    'private',
    'approved',
    v_display_name,
    COALESCE(v_org.name, v_display_name),
    COALESCE(v_user.email, NULL),
    jsonb_build_object('source', 'marketplace_provider_opt_in_v1'),
    COALESCE(p_profile, '{}'::jsonb),
    now()
  )
  ON CONFLICT (organization_id) DO UPDATE
  SET
    participant_type_key = EXCLUDED.participant_type_key,
    status = 'approved',
    listing_status = COALESCE(public.marketplace_participant_profiles.listing_status, EXCLUDED.listing_status),
    compliance_state = 'approved',
    display_name = EXCLUDED.display_name,
    legal_name = EXCLUDED.legal_name,
    contact_email = COALESCE(EXCLUDED.contact_email, public.marketplace_participant_profiles.contact_email),
    network_metadata = COALESCE(public.marketplace_participant_profiles.network_metadata, '{}'::jsonb)
      || EXCLUDED.network_metadata,
    profile = COALESCE(public.marketplace_participant_profiles.profile, '{}'::jsonb)
      || EXCLUDED.profile,
    last_verified_at = now(),
    suspended_at = NULL,
    updated_at = now()
  RETURNING id INTO v_profile_id;

  INSERT INTO public.marketplace_participant_memberships (
    participant_profile_id,
    user_id,
    membership_role,
    status,
    is_primary,
    metadata
  )
  VALUES (
    v_profile_id,
    v_user_id,
    'owner',
    'active',
    TRUE,
    jsonb_build_object('source', 'marketplace_provider_opt_in_v1')
  )
  ON CONFLICT (participant_profile_id, user_id) DO UPDATE
  SET
    membership_role = 'owner',
    status = 'active',
    is_primary = TRUE,
    metadata = COALESCE(public.marketplace_participant_memberships.metadata, '{}'::jsonb)
      || EXCLUDED.metadata,
    updated_at = now();

  FOR v_capability IN
    SELECT value
      FROM jsonb_array_elements_text(
        CASE
          WHEN jsonb_typeof(p_capabilities) = 'array' THEN p_capabilities
          ELSE '[]'::jsonb
        END
      ) AS capability(value)
  LOOP
    IF btrim(COALESCE(v_capability, '')) = '' THEN
      CONTINUE;
    END IF;

    INSERT INTO public.marketplace_participant_capabilities (
      participant_profile_id,
      capability_key,
      status,
      evidence,
      metadata
    )
    VALUES (
      v_profile_id,
      lower(btrim(v_capability)),
      'active',
      '{}'::jsonb,
      jsonb_build_object('source', 'marketplace_provider_opt_in_v1')
    )
    ON CONFLICT (participant_profile_id, capability_key) DO UPDATE
    SET
      status = 'active',
      metadata = COALESCE(public.marketplace_participant_capabilities.metadata, '{}'::jsonb)
        || EXCLUDED.metadata,
      updated_at = now();
  END LOOP;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_participant_profile',
    v_profile_id,
    'participant_profile.approved',
    jsonb_build_object('participant_type_key', 'provider_tenant')
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'status', 'approved',
    'participant_profile_id', v_profile_id
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 4) Request -> offer -> award -> work package
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_request_create_v1(
  p_request_kind_key TEXT,
  p_title TEXT,
  p_summary TEXT DEFAULT NULL,
  p_request_details JSONB DEFAULT '{}'::jsonb,
  p_items JSONB DEFAULT '[]'::jsonb,
  p_private_pool JSONB DEFAULT '[]'::jsonb,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_kind public.marketplace_request_kinds%ROWTYPE;
  v_request_policy RECORD;
  v_marketplace_policy RECORD;
  v_request_id UUID := gen_random_uuid();
  v_status TEXT := 'draft';
  v_auto_publish BOOLEAN := FALSE;
  v_expire_hours INT := 24;
  v_item JSONB;
  v_item_key TEXT;
  v_sort_order INT := 100;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  SELECT *
    INTO v_kind
    FROM public.marketplace_request_kinds rk
   WHERE rk.kind_key = lower(btrim(COALESCE(p_request_kind_key, '')))
     AND rk.is_active = TRUE
   LIMIT 1;

  IF v_kind.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_kind_invalid'));
  END IF;

  SELECT *
    INTO v_request_policy
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_request_policy',
      jsonb_build_object('organization_id', v_org_id, 'request_kind_key', v_kind.kind_key)
    )
   LIMIT 1;

  SELECT *
    INTO v_marketplace_policy
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_policy',
      jsonb_build_object('organization_id', v_org_id, 'request_kind_key', v_kind.kind_key)
    )
   LIMIT 1;

  IF NOT public.tenant_signup_policy_bool_v1(v_request_policy.value, ARRAY['enabled'], TRUE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'requests_disabled'));
  END IF;

  IF NOT (
    v_kind.kind_key = ANY (
      public.tenant_signup_jsonb_text_array_v1(v_request_policy.value #> ARRAY['allowed_request_kinds'])
    )
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_kind_not_allowed'));
  END IF;

  v_status := COALESCE(NULLIF(v_request_policy.value #>> ARRAY['request_defaults', 'status'], ''), 'draft');
  v_auto_publish := public.tenant_signup_policy_bool_v1(
    v_request_policy.value,
    ARRAY['request_defaults', 'auto_publish'],
    FALSE
  );
  v_expire_hours := public.tenant_signup_policy_int_v1(
    v_request_policy.value,
    ARRAY['request_defaults', 'expire_hours'],
    24,
    1,
    720
  );

  INSERT INTO public.marketplace_requests (
    id,
    requester_organization_id,
    request_kind_key,
    status,
    release_state,
    title,
    summary,
    request_details,
    private_pool,
    visibility_mode_key,
    pricing_mode_key,
    negotiation_mode_key,
    ownership_mode_key,
    settlement_mode_key,
    tracking_display_mode_key,
    materializer_key,
    published_at,
    expires_at,
    metadata,
    decision_metadata
  )
  VALUES (
    v_request_id,
    v_org_id,
    v_kind.kind_key,
    CASE WHEN v_auto_publish THEN 'published' ELSE v_status END,
    'private_pool',
    btrim(COALESCE(p_title, '')),
    NULLIF(btrim(COALESCE(p_summary, '')), ''),
    COALESCE(p_request_details, '{}'::jsonb),
    CASE WHEN jsonb_typeof(p_private_pool) = 'array' THEN p_private_pool ELSE '[]'::jsonb END,
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_visibility_mode', ''), 'private_pool_first'),
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_pricing_mode', ''), 'quote'),
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_negotiation_mode', ''), 'counter'),
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_ownership_mode', ''), 'origin_tenant'),
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_settlement_mode', ''), 'manual_recorded'),
    COALESCE(NULLIF(v_marketplace_policy.value->>'default_tracking_display_mode', ''), 'origin_brand_only'),
    COALESCE(v_kind.default_materializer_key, 'manual_bridge'),
    CASE WHEN v_auto_publish THEN now() ELSE NULL END,
    COALESCE(p_expires_at, now() + make_interval(hours => v_expire_hours)),
    COALESCE(p_metadata, '{}'::jsonb),
    jsonb_build_object(
      'request_policy_resolution_id', v_request_policy.settings_resolution_id,
      'marketplace_policy_resolution_id', v_marketplace_policy.settings_resolution_id
    )
  );

  IF jsonb_typeof(p_items) = 'array' AND jsonb_array_length(p_items) > 0 THEN
    FOR v_item IN SELECT value FROM jsonb_array_elements(p_items) AS item(value) LOOP
      v_item_key := COALESCE(NULLIF(btrim(COALESCE(v_item->>'item_key', '')), ''), 'item-' || gen_random_uuid()::text);
      BEGIN
        v_sort_order := COALESCE(NULLIF(v_item->>'sort_order', '')::int, 100);
      EXCEPTION
        WHEN others THEN
          v_sort_order := 100;
      END;

      INSERT INTO public.marketplace_request_items (
        request_id,
        item_key,
        sort_order,
        status,
        payload,
        metadata
      )
      VALUES (
        v_request_id,
        v_item_key,
        v_sort_order,
        'open',
        COALESCE(v_item->'payload', '{}'::jsonb),
        COALESCE(v_item->'metadata', '{}'::jsonb)
      );
    END LOOP;
  ELSE
    INSERT INTO public.marketplace_request_items (
      request_id,
      item_key,
      sort_order,
      status,
      payload,
      metadata
    )
    VALUES (
      v_request_id,
      'primary',
      100,
      'open',
      COALESCE(p_request_details, '{}'::jsonb),
      '{}'::jsonb
    );
  END IF;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'marketplace_request_policy',
    p_resource_type := 'marketplace_request',
    p_resource_id := v_request_id,
    p_decision_point := 'request.create',
    p_decision_outcome := CASE WHEN v_auto_publish THEN 'published' ELSE 'draft' END,
    p_performed_by_system := 'marketplace_request_create_v1',
    p_decision_inputs := jsonb_build_object('request_kind_key', v_kind.kind_key),
    p_decision_reason := 'request_created',
    p_settings_resolution_id := v_request_policy.settings_resolution_id
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_request_id,
    CASE WHEN v_auto_publish THEN 'request.published' ELSE 'request.created' END,
    jsonb_build_object(
      'request_kind_key', v_kind.kind_key,
      'status', CASE WHEN v_auto_publish THEN 'published' ELSE v_status END
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_request_id,
    'status', CASE WHEN v_auto_publish THEN 'published' ELSE v_status END
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_publish_v1(
  p_request_id UUID,
  p_release_state TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
  v_release_state TEXT := lower(btrim(COALESCE(p_release_state, '')));
  v_visibility RECORD;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status = 'published' THEN
    RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'published', 'already_processed', TRUE);
  END IF;

  SELECT *
    INTO v_visibility
    FROM public.marketplace_resolve_policy_row_v1(
      'marketplace_visibility_policy',
      jsonb_build_object('organization_id', v_org_id, 'request_kind_key', v_req.request_kind_key)
    )
   LIMIT 1;

  IF v_release_state = '' THEN
    v_release_state := v_req.release_state;
  END IF;
  IF v_release_state = 'curated_network'
     AND NOT public.tenant_signup_policy_bool_v1(v_visibility.value, ARRAY['allow_curated_network_release'], TRUE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'curated_network_release_blocked'));
  END IF;
  IF v_release_state = 'public'
     AND NOT public.tenant_signup_policy_bool_v1(v_visibility.value, ARRAY['allow_public_release'], FALSE) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'public_release_blocked'));
  END IF;

  UPDATE public.marketplace_requests
     SET status = 'published',
         release_state = COALESCE(NULLIF(v_release_state, ''), release_state),
         published_at = COALESCE(published_at, now()),
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.log_decision(
    p_organization_id := v_org_id,
    p_decision_category := 'marketplace_visibility_policy',
    p_resource_type := 'marketplace_request',
    p_resource_id := v_req.id,
    p_decision_point := 'request.publish',
    p_decision_outcome := 'published',
    p_performed_by_system := 'marketplace_request_publish_v1',
    p_decision_inputs := jsonb_build_object('release_state', COALESCE(NULLIF(v_release_state, ''), v_req.release_state)),
    p_decision_reason := 'request_published',
    p_settings_resolution_id := v_visibility.settings_resolution_id
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_req.id,
    'request.published',
    jsonb_build_object('release_state', COALESCE(NULLIF(v_release_state, ''), v_req.release_state))
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'published');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_request_cancel_v1(
  p_request_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  UPDATE public.marketplace_requests
     SET status = 'cancelled',
         closed_at = now(),
         updated_at = now(),
         decision_metadata = COALESCE(decision_metadata, '{}'::jsonb)
           || jsonb_build_object('cancel_reason', NULLIF(btrim(COALESCE(p_reason, '')), ''))
   WHERE id = v_req.id;

  UPDATE public.marketplace_request_items
     SET status = 'cancelled',
         updated_at = now()
   WHERE request_id = v_req.id
     AND status <> 'cancelled';

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_request',
    v_req.id,
    'request.cancelled',
    jsonb_build_object('reason', NULLIF(btrim(COALESCE(p_reason, '')), ''))
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_req.id, 'status', 'cancelled');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_offer_submit_v1(
  p_request_id UUID,
  p_message TEXT DEFAULT NULL,
  p_terms JSONB DEFAULT '{}'::jsonb,
  p_pricing JSONB DEFAULT '{}'::jsonb,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_req public.marketplace_requests%ROWTYPE;
  v_kind public.marketplace_request_kinds%ROWTYPE;
  v_profile public.marketplace_participant_profiles%ROWTYPE;
  v_offer_id UUID := gen_random_uuid();
  v_caps JSONB := '[]'::jsonb;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_offers.write', 'tenant', v_org_id);

  SELECT *
    INTO v_profile
    FROM public.marketplace_participant_profiles p
   WHERE p.organization_id = v_org_id
     AND p.status = 'approved'
     AND p.compliance_state = 'approved'
   LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'approved_participant_required'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.requester_organization_id = v_org_id THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'self_offer_not_allowed'));
  END IF;

  IF v_req.status <> 'published' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_open'));
  END IF;

  SELECT *
    INTO v_kind
    FROM public.marketplace_request_kinds rk
   WHERE rk.kind_key = v_req.request_kind_key
   LIMIT 1;

  IF v_kind.participant_type_supply_key IS NOT NULL
     AND v_kind.participant_type_supply_key <> v_profile.participant_type_key THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'participant_type_not_eligible'));
  END IF;

  SELECT COALESCE(
           jsonb_agg(
             jsonb_build_object(
               'capability_key', c.capability_key,
               'status', c.status
             )
             ORDER BY c.capability_key
           ),
           '[]'::jsonb
         )
    INTO v_caps
    FROM public.marketplace_participant_capabilities c
   WHERE c.participant_profile_id = v_profile.id
     AND c.status = 'active';

  INSERT INTO public.marketplace_offers (
    id,
    request_id,
    supplier_participant_profile_id,
    supplier_organization_id,
    status,
    message,
    terms,
    pricing,
    capabilities_snapshot,
    submitted_at,
    expires_at,
    metadata
  )
  VALUES (
    v_offer_id,
    v_req.id,
    v_profile.id,
    v_org_id,
    'submitted',
    NULLIF(btrim(COALESCE(p_message, '')), ''),
    COALESCE(p_terms, '{}'::jsonb),
    COALESCE(p_pricing, '{}'::jsonb),
    v_caps,
    now(),
    p_expires_at,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (request_id, supplier_participant_profile_id) DO UPDATE
  SET
    status = 'submitted',
    message = EXCLUDED.message,
    terms = EXCLUDED.terms,
    pricing = EXCLUDED.pricing,
    capabilities_snapshot = EXCLUDED.capabilities_snapshot,
    submitted_at = now(),
    responded_at = NULL,
    withdrawn_at = NULL,
    expires_at = EXCLUDED.expires_at,
    metadata = COALESCE(public.marketplace_offers.metadata, '{}'::jsonb)
      || EXCLUDED.metadata,
    updated_at = now()
  RETURNING id INTO v_offer_id;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_offer',
    v_offer_id,
    'offer.submitted',
    jsonb_build_object('request_id', v_req.id)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_offer_id, 'status', 'submitted');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_offer_withdraw_v1(
  p_offer_id UUID,
  p_reason TEXT DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_offer public.marketplace_offers%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_offers.write', 'tenant', v_org_id);

  SELECT *
    INTO v_offer
    FROM public.marketplace_offers o
   WHERE o.id = p_offer_id
     AND o.supplier_organization_id = v_org_id
   FOR UPDATE;

  IF v_offer.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'offer_not_found'));
  END IF;

  UPDATE public.marketplace_offers
     SET status = 'withdrawn',
         withdrawn_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb)
           || jsonb_build_object('withdraw_reason', NULLIF(btrim(COALESCE(p_reason, '')), '')),
         updated_at = now()
   WHERE id = v_offer.id;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_offer',
    v_offer.id,
    'offer.withdrawn',
    jsonb_build_object('reason', NULLIF(btrim(COALESCE(p_reason, '')), ''))
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_offer.id, 'status', 'withdrawn');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_award_offer_v1(
  p_offer_id UUID,
  p_award_reason TEXT DEFAULT NULL,
  p_award_terms JSONB DEFAULT '{}'::jsonb,
  p_expires_at TIMESTAMPTZ DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_offer public.marketplace_offers%ROWTYPE;
  v_req public.marketplace_requests%ROWTYPE;
  v_award_id UUID := gen_random_uuid();
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_awards.write', 'tenant', v_org_id);

  SELECT *
    INTO v_offer
    FROM public.marketplace_offers o
   WHERE o.id = p_offer_id
   FOR UPDATE;

  IF v_offer.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'offer_not_found'));
  END IF;

  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = v_offer.request_id
     AND r.requester_organization_id = v_org_id
   FOR UPDATE;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.marketplace_awards a
     WHERE a.request_id = v_req.id
       AND a.status IN ('pending_acceptance', 'accepted', 'materialized')
       AND a.offer_id <> v_offer.id
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_already_awarded'));
  END IF;

  INSERT INTO public.marketplace_awards (
    id,
    request_id,
    offer_id,
    requester_organization_id,
    supplier_organization_id,
    supplier_participant_profile_id,
    status,
    awarded_by_user_id,
    award_reason,
    award_terms,
    expires_at,
    metadata
  )
  VALUES (
    v_award_id,
    v_req.id,
    v_offer.id,
    v_req.requester_organization_id,
    v_offer.supplier_organization_id,
    v_offer.supplier_participant_profile_id,
    'pending_acceptance',
    auth.uid(),
    NULLIF(btrim(COALESCE(p_award_reason, '')), ''),
    COALESCE(p_award_terms, '{}'::jsonb),
    p_expires_at,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (offer_id) DO UPDATE
  SET
    status = 'pending_acceptance',
    awarded_by_user_id = EXCLUDED.awarded_by_user_id,
    award_reason = EXCLUDED.award_reason,
    award_terms = EXCLUDED.award_terms,
    expires_at = EXCLUDED.expires_at,
    metadata = COALESCE(public.marketplace_awards.metadata, '{}'::jsonb)
      || EXCLUDED.metadata,
    rejected_at = NULL,
    accepted_at = NULL,
    updated_at = now()
  RETURNING id INTO v_award_id;

  UPDATE public.marketplace_requests
     SET status = 'award_pending_acceptance',
         awarded_offer_id = v_offer.id,
         updated_at = now()
   WHERE id = v_req.id;

  INSERT INTO public.marketplace_contracts (
    award_id,
    request_id,
    requester_organization_id,
    supplier_organization_id,
    supplier_participant_profile_id,
    status,
    ownership_mode_key,
    settlement_mode_key,
    terms,
    metadata
  )
  VALUES (
    v_award_id,
    v_req.id,
    v_req.requester_organization_id,
    v_offer.supplier_organization_id,
    v_offer.supplier_participant_profile_id,
    'pending_acceptance',
    v_req.ownership_mode_key,
    v_req.settlement_mode_key,
    COALESCE(p_award_terms, '{}'::jsonb),
    jsonb_build_object('awarded_offer_id', v_offer.id)
  )
  ON CONFLICT (award_id) DO UPDATE
  SET
    status = 'pending_acceptance',
    terms = EXCLUDED.terms,
    metadata = COALESCE(public.marketplace_contracts.metadata, '{}'::jsonb)
      || EXCLUDED.metadata,
    cancelled_at = NULL,
    updated_at = now();

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_award',
    v_award_id,
    'award.issued',
    jsonb_build_object('request_id', v_req.id, 'offer_id', v_offer.id)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_award_id, 'status', 'pending_acceptance');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_award_respond_v1(
  p_award_id UUID,
  p_decision TEXT,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_decision TEXT := lower(btrim(COALESCE(p_decision, '')));
  v_award public.marketplace_awards%ROWTYPE;
  v_req public.marketplace_requests%ROWTYPE;
  v_offer public.marketplace_offers%ROWTYPE;
  v_contract public.marketplace_contracts%ROWTYPE;
  v_work_package_id UUID := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_awards.write', 'tenant', v_org_id);

  IF v_decision = 'approve' THEN
    v_decision := 'accepted';
  ELSIF v_decision = 'reject' THEN
    v_decision := 'rejected';
  END IF;

  IF v_decision NOT IN ('accepted', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_decision'));
  END IF;

  SELECT *
    INTO v_award
    FROM public.marketplace_awards a
   WHERE a.id = p_award_id
     AND a.supplier_organization_id = v_org_id
   FOR UPDATE;

  IF v_award.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'award_not_found'));
  END IF;

  SELECT * INTO v_req FROM public.marketplace_requests WHERE id = v_award.request_id FOR UPDATE;
  SELECT * INTO v_offer FROM public.marketplace_offers WHERE id = v_award.offer_id FOR UPDATE;
  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE award_id = v_award.id FOR UPDATE;

  IF v_decision = 'rejected' THEN
    UPDATE public.marketplace_awards
       SET status = 'rejected',
           rejected_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_award.id;

    UPDATE public.marketplace_contracts
       SET status = 'rejected',
           cancelled_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE award_id = v_award.id;

    UPDATE public.marketplace_requests
       SET status = 'published',
           awarded_offer_id = NULL,
           updated_at = now()
     WHERE id = v_award.request_id;

    UPDATE public.marketplace_offers
       SET status = 'rejected',
           responded_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_award.offer_id;

    PERFORM public.marketplace_append_event_v1(
      v_org_id,
      'marketplace_award',
      v_award.id,
      'award.rejected',
      jsonb_build_object('request_id', v_award.request_id)
    );

    RETURN jsonb_build_object('ok', TRUE, 'id', v_award.id, 'status', 'rejected');
  END IF;

  UPDATE public.marketplace_awards
     SET status = 'accepted',
         accepted_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_award.id;

  UPDATE public.marketplace_contracts
     SET status = 'active',
         activated_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE award_id = v_award.id
   RETURNING * INTO v_contract;

  UPDATE public.marketplace_requests
     SET status = 'awarded',
         updated_at = now()
   WHERE id = v_award.request_id;

  UPDATE public.marketplace_offers
     SET status = 'accepted',
         responded_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_award.offer_id;

  INSERT INTO public.marketplace_work_packages (
    contract_id,
    award_id,
    request_id,
    requester_organization_id,
    supplier_organization_id,
    supplier_participant_profile_id,
    materializer_key,
    status,
    materialization_state,
    summary,
    execution_ref,
    metadata
  )
  VALUES (
    v_contract.id,
    v_award.id,
    v_award.request_id,
    v_award.requester_organization_id,
    v_award.supplier_organization_id,
    v_award.supplier_participant_profile_id,
    COALESCE(v_req.materializer_key, 'manual_bridge'),
    'ready',
    'pending',
    jsonb_build_object(
      'title', v_req.title,
      'summary', v_req.summary,
      'request_kind_key', v_req.request_kind_key
    ),
    '{}'::jsonb,
    COALESCE(p_metadata, '{}'::jsonb)
  )
  ON CONFLICT (award_id) DO UPDATE
  SET
    status = 'ready',
    materialization_state = 'pending',
    summary = EXCLUDED.summary,
    metadata = COALESCE(public.marketplace_work_packages.metadata, '{}'::jsonb)
      || EXCLUDED.metadata,
    cancelled_at = NULL,
    updated_at = now()
  RETURNING id INTO v_work_package_id;

  PERFORM public.marketplace_append_reputation_event_v1(
    v_award.supplier_participant_profile_id,
    'award_accepted',
    'completion_rate',
    1,
    1,
    'marketplace_award',
    v_award.id,
    jsonb_build_object('status', 'accepted')
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_award',
    v_award.id,
    'award.accepted',
    jsonb_build_object('work_package_id', v_work_package_id)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_award.id,
    'status', 'accepted',
    'work_package_id', v_work_package_id
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_work_package_materialize_v1(
  p_work_package_id UUID DEFAULT NULL,
  p_award_id UUID DEFAULT NULL,
  p_execution_ref JSONB DEFAULT '{}'::jsonb,
  p_summary JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_wp public.marketplace_work_packages%ROWTYPE;
  v_materializer JSONB := '{}'::jsonb;
  v_execution_target TEXT := 'manual';
  v_materialization_state TEXT := 'manual';
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_work_packages.write', 'tenant', v_org_id);

  SELECT *
    INTO v_wp
    FROM public.marketplace_work_packages wp
   WHERE (
         (p_work_package_id IS NOT NULL AND wp.id = p_work_package_id)
      OR (p_award_id IS NOT NULL AND wp.award_id = p_award_id)
   )
     AND (wp.requester_organization_id = v_org_id OR wp.supplier_organization_id = v_org_id)
   FOR UPDATE;

  IF v_wp.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_found'));
  END IF;

  SELECT e.config
    INTO v_materializer
    FROM public.marketplace_registry_entries e
   WHERE e.registry_type = 'materializer'
     AND e.entry_key = v_wp.materializer_key
   LIMIT 1;

  v_execution_target := COALESCE(NULLIF(v_materializer->>'execution_target', ''), 'manual');
  IF v_execution_target = 'manual' THEN
    v_materialization_state := 'manual';
  ELSE
    v_materialization_state := 'materialized';
  END IF;

  UPDATE public.marketplace_work_packages
     SET materialization_state = v_materialization_state,
         status = CASE WHEN v_materialization_state = 'materialized' THEN 'in_execution' ELSE 'ready' END,
         summary = COALESCE(summary, '{}'::jsonb) || COALESCE(p_summary, '{}'::jsonb),
         execution_ref = COALESCE(execution_ref, '{}'::jsonb)
           || COALESCE(p_execution_ref, '{}'::jsonb)
           || jsonb_build_object('execution_target', v_execution_target),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         materialized_at = now(),
         updated_at = now()
   WHERE id = v_wp.id;

  UPDATE public.marketplace_awards
     SET status = 'materialized',
         updated_at = now()
   WHERE id = v_wp.award_id;

  UPDATE public.marketplace_requests
     SET status = 'in_execution',
         updated_at = now()
   WHERE id = v_wp.request_id;

  PERFORM public.marketplace_append_event_v1(
    v_wp.requester_organization_id,
    'marketplace_work_package',
    v_wp.id,
    'work_package.materialized',
    jsonb_build_object('execution_target', v_execution_target)
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_wp.id,
    'status', CASE WHEN v_materialization_state = 'materialized' THEN 'in_execution' ELSE 'ready' END,
    'materialization_state', v_materialization_state,
    'execution_target', v_execution_target
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 5) Disputes + advisory projections
-------------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.marketplace_dispute_open_v1(
  p_contract_id UUID DEFAULT NULL,
  p_work_package_id UUID DEFAULT NULL,
  p_title TEXT DEFAULT NULL,
  p_description TEXT DEFAULT NULL,
  p_category TEXT DEFAULT 'general',
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_contract public.marketplace_contracts%ROWTYPE;
  v_work_package public.marketplace_work_packages%ROWTYPE;
  v_dispute_id UUID := gen_random_uuid();
  v_counterparty_org_id UUID := NULL;
  v_request_id UUID := NULL;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_disputes.write', 'tenant', v_org_id);

  IF p_contract_id IS NOT NULL THEN
    SELECT *
      INTO v_contract
      FROM public.marketplace_contracts c
     WHERE c.id = p_contract_id
       AND (c.requester_organization_id = v_org_id OR c.supplier_organization_id = v_org_id)
     LIMIT 1;
  END IF;

  IF p_work_package_id IS NOT NULL THEN
    SELECT *
      INTO v_work_package
      FROM public.marketplace_work_packages wp
     WHERE wp.id = p_work_package_id
       AND (wp.requester_organization_id = v_org_id OR wp.supplier_organization_id = v_org_id)
     LIMIT 1;
  END IF;

  IF v_contract.id IS NULL AND v_work_package.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'contract_or_work_package_required'));
  END IF;

  IF v_work_package.id IS NOT NULL THEN
    v_counterparty_org_id := CASE
      WHEN v_work_package.requester_organization_id = v_org_id THEN v_work_package.supplier_organization_id
      ELSE v_work_package.requester_organization_id
    END;
    v_request_id := v_work_package.request_id;
    IF v_contract.id IS NULL AND v_work_package.contract_id IS NOT NULL THEN
      SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_work_package.contract_id LIMIT 1;
    END IF;
  ELSE
    v_counterparty_org_id := CASE
      WHEN v_contract.requester_organization_id = v_org_id THEN v_contract.supplier_organization_id
      ELSE v_contract.requester_organization_id
    END;
    v_request_id := v_contract.request_id;
  END IF;

  INSERT INTO public.marketplace_disputes (
    id,
    request_id,
    contract_id,
    work_package_id,
    opened_by_organization_id,
    counterparty_organization_id,
    opened_by_user_id,
    status,
    category,
    title,
    description,
    metadata
  )
  VALUES (
    v_dispute_id,
    v_request_id,
    v_contract.id,
    v_work_package.id,
    v_org_id,
    v_counterparty_org_id,
    auth.uid(),
    'open',
    COALESCE(NULLIF(btrim(COALESCE(p_category, '')), ''), 'general'),
    COALESCE(NULLIF(btrim(COALESCE(p_title, '')), ''), 'Marketplace dispute'),
    NULLIF(btrim(COALESCE(p_description, '')), ''),
    COALESCE(p_metadata, '{}'::jsonb)
  );

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_dispute',
    v_dispute_id,
    'dispute.opened',
    jsonb_build_object('counterparty_organization_id', v_counterparty_org_id)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_dispute_id, 'status', 'open');
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_dispute_resolve_v1(
  p_dispute_id UUID,
  p_resolution TEXT,
  p_status TEXT DEFAULT 'resolved',
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_dispute public.marketplace_disputes%ROWTYPE;
  v_status TEXT := lower(btrim(COALESCE(p_status, 'resolved')));
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.is_platform_user() THEN
    RAISE EXCEPTION 'platform_scope_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_disputes.write', 'global', NULL);

  IF v_status NOT IN ('resolved', 'rejected') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'invalid_status'));
  END IF;

  SELECT *
    INTO v_dispute
    FROM public.marketplace_disputes d
   WHERE d.id = p_dispute_id
   FOR UPDATE;

  IF v_dispute.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'dispute_not_found'));
  END IF;

  UPDATE public.marketplace_disputes
     SET status = v_status,
         resolution = NULLIF(btrim(COALESCE(p_resolution, '')), ''),
         resolved_at = now(),
         resolved_by_user_id = auth.uid(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_dispute.id;

  PERFORM public.marketplace_append_event_v1(
    v_dispute.opened_by_organization_id,
    'marketplace_dispute',
    v_dispute.id,
    'dispute.' || v_status,
    jsonb_build_object('resolved_by_user_id', auth.uid())
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_dispute.id, 'status', v_status);
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_reputation_snapshot_v1(
  p_participant_profile_id UUID DEFAULT NULL,
  p_organization_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_profile_id UUID := p_participant_profile_id;
  v_org_id UUID := COALESCE(p_organization_id, public.current_user_org_id());
  v_snapshot public.marketplace_reputation_snapshots%ROWTYPE;
BEGIN
  IF v_profile_id IS NULL THEN
    SELECT p.id
      INTO v_profile_id
      FROM public.marketplace_participant_profiles p
     WHERE p.organization_id = v_org_id
     LIMIT 1;
  END IF;

  SELECT *
    INTO v_snapshot
    FROM public.marketplace_reputation_snapshots s
   WHERE s.participant_profile_id = v_profile_id
   LIMIT 1;

  RETURN jsonb_build_object(
    'participant_profile_id', v_profile_id,
    'organization_id', v_snapshot.organization_id,
    'score', v_snapshot.score,
    'event_count', v_snapshot.event_count,
    'completion_rate', v_snapshot.completion_rate,
    'cancellation_rate', v_snapshot.cancellation_rate,
    'dispute_rate', v_snapshot.dispute_rate,
    'document_freshness', v_snapshot.document_freshness,
    'feedback_score', v_snapshot.feedback_score,
    'snapshot', v_snapshot.snapshot
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_matching_suggestions_v1(
  p_request_id UUID,
  p_limit INTEGER DEFAULT 10
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_requests%ROWTYPE;
  v_kind public.marketplace_request_kinds%ROWTYPE;
  v_limit INT := GREATEST(1, LEAST(COALESCE(p_limit, 10), 100));
BEGIN
  SELECT *
    INTO v_req
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
   LIMIT 1;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  SELECT *
    INTO v_kind
    FROM public.marketplace_request_kinds rk
   WHERE rk.kind_key = v_req.request_kind_key
   LIMIT 1;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'request_id', v_req.id,
    'matches', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'participant_profile_id', p.id,
                 'organization_id', p.organization_id,
                 'display_name', p.display_name,
                 'participant_type_key', p.participant_type_key,
                 'listing_status', p.listing_status,
                 'score', COALESCE(s.score, 0),
                 'private_pool_match', EXISTS (
                   SELECT 1
                     FROM jsonb_array_elements_text(
                       CASE
                         WHEN jsonb_typeof(v_req.private_pool) = 'array' THEN v_req.private_pool
                         ELSE '[]'::jsonb
                       END
                     ) AS pool(value)
                    WHERE pool.value = p.organization_id::text
                 )
               )
             )
        FROM (
          SELECT p.*
            FROM public.marketplace_participant_profiles p
            LEFT JOIN public.marketplace_reputation_snapshots s
              ON s.participant_profile_id = p.id
           WHERE p.status = 'approved'
             AND p.compliance_state = 'approved'
             AND p.participant_type_key = v_kind.participant_type_supply_key
             AND (
               p.organization_id <> v_req.requester_organization_id
               OR v_req.requester_organization_id IS NULL
             )
             AND (
               p.listing_status IN ('curated_network', 'public')
               OR EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(v_req.private_pool) = 'array' THEN v_req.private_pool
                       ELSE '[]'::jsonb
                     END
                   ) AS pool(value)
                  WHERE pool.value = p.organization_id::text
               )
             )
           ORDER BY
             CASE
               WHEN EXISTS (
                 SELECT 1
                   FROM jsonb_array_elements_text(
                     CASE
                       WHEN jsonb_typeof(v_req.private_pool) = 'array' THEN v_req.private_pool
                       ELSE '[]'::jsonb
                     END
                   ) AS pool(value)
                  WHERE pool.value = p.organization_id::text
               ) THEN 0
               ELSE 1
             END,
             COALESCE(s.score, 0) DESC,
             p.updated_at DESC
           LIMIT v_limit
        ) p
        LEFT JOIN public.marketplace_reputation_snapshots s
          ON s.participant_profile_id = p.id
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_pricing_suggestion_v1(
  p_request_kind_key TEXT,
  p_request_details JSONB DEFAULT '{}'::jsonb,
  p_terms JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_kind_key TEXT := lower(btrim(COALESCE(p_request_kind_key, '')));
  v_avg_total NUMERIC(18,2) := NULL;
  v_offer_count INTEGER := 0;
BEGIN
  SELECT
    AVG(NULLIF(o.pricing->>'total_amount', '')::numeric),
    COUNT(*)
    INTO v_avg_total, v_offer_count
    FROM public.marketplace_offers o
    JOIN public.marketplace_requests r
      ON r.id = o.request_id
   WHERE r.request_kind_key = v_kind_key
     AND o.status IN ('accepted', 'submitted', 'countered')
     AND o.created_at >= (now() - interval '90 days')
     AND (o.pricing ? 'total_amount');

  RETURN jsonb_build_object(
    'ok', TRUE,
    'advisory_only', TRUE,
    'request_kind_key', v_kind_key,
    'observations', jsonb_build_object(
      'offer_count', COALESCE(v_offer_count, 0),
      'average_total_amount', v_avg_total
    ),
    'request_details', COALESCE(p_request_details, '{}'::jsonb),
    'terms', COALESCE(p_terms, '{}'::jsonb)
  );
END;
$function$;

-------------------------------------------------------------------------------
-- 6) Privileges
-------------------------------------------------------------------------------

REVOKE ALL ON FUNCTION public.marketplace_policy_default_v1(TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_policy_lookup_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_resolve_policy_row_v1(TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_request_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_visibility_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_execution_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_settlement_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_reputation_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_tracking_display_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_compliance_policy_v1(JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_request_kind_catalog_v1(JSONB, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_append_event_v1(UUID, TEXT, UUID, TEXT, JSONB, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_refresh_reputation_snapshot_v1(UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_append_reputation_event_v1(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_assert_reviewer_v1() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_participant_request_record_error_v1(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_participant_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_apply_participant_request_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_provider_opt_in_v1(TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_request_create_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_request_publish_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_request_cancel_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_offer_submit_v1(UUID, TEXT, JSONB, JSONB, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_offer_withdraw_v1(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_award_offer_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_award_respond_v1(UUID, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_work_package_materialize_v1(UUID, UUID, JSONB, JSONB, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_dispute_open_v1(UUID, UUID, TEXT, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_dispute_resolve_v1(UUID, TEXT, TEXT, JSONB) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_reputation_snapshot_v1(UUID, UUID) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_matching_suggestions_v1(UUID, INTEGER) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.marketplace_pricing_suggestion_v1(TEXT, JSONB, JSONB) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.marketplace_policy_default_v1(TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_policy_lookup_v1(TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_resolve_policy_row_v1(TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_visibility_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_execution_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_settlement_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_reputation_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_tracking_display_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_compliance_policy_v1(JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_kind_catalog_v1(JSONB, BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_assert_reviewer_v1() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_provider_opt_in_v1(TEXT, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_create_v1(TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, TIMESTAMPTZ, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_publish_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_request_cancel_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_offer_submit_v1(UUID, TEXT, JSONB, JSONB, TIMESTAMPTZ, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_offer_withdraw_v1(UUID, TEXT) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_award_offer_v1(UUID, TEXT, JSONB, TIMESTAMPTZ, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_award_respond_v1(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_work_package_materialize_v1(UUID, UUID, JSONB, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_dispute_open_v1(UUID, UUID, TEXT, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_dispute_resolve_v1(UUID, TEXT, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_reputation_snapshot_v1(UUID, UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_matching_suggestions_v1(UUID, INTEGER) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_pricing_suggestion_v1(TEXT, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_append_event_v1(UUID, TEXT, UUID, TEXT, JSONB, UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_refresh_reputation_snapshot_v1(UUID) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_append_reputation_event_v1(UUID, TEXT, TEXT, NUMERIC, NUMERIC, TEXT, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_record_error_v1(UUID, TEXT, TEXT, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_create_v1(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, JSONB, JSONB, JSONB, JSONB, UUID, UUID, TEXT, BOOLEAN) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_apply_participant_request_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB) TO service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_participant_request_review_apply_v1(UUID, TEXT, UUID, UUID, BOOLEAN, TEXT, UUID, UUID, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202603071120_marketplace_network_rpc_v1'));
COMMIT;
