-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace network offer, award, and materialization lifecycle

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081210_marketplace_network_offer_award_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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

  IF v_req.expires_at IS NOT NULL AND v_req.expires_at <= now() THEN
    UPDATE public.marketplace_requests
       SET status = 'expired',
           closed_at = COALESCE(closed_at, now()),
           updated_at = now()
     WHERE id = v_req.id
       AND status NOT IN ('completed', 'settled', 'cancelled', 'expired');

    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_expired'));
  END IF;

  IF v_req.release_state = 'private_pool'
     AND NOT public.marketplace_private_pool_contains_v1(v_req.private_pool, v_org_id) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_visible'));
  END IF;

  IF v_req.status NOT IN ('published', 'negotiation') THEN
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

  UPDATE public.marketplace_requests
     SET status = 'negotiation',
         updated_at = now()
   WHERE id = v_req.id
     AND status IN ('published', 'negotiation');

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

CREATE OR REPLACE FUNCTION public.marketplace_offer_counter_v1(
  p_offer_id UUID,
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
  v_offer public.marketplace_offers%ROWTYPE;
  v_req public.marketplace_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_requests.write', 'tenant', v_org_id);

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

  IF v_req.status NOT IN ('published', 'negotiation') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_open'));
  END IF;

  UPDATE public.marketplace_offers
     SET status = 'countered',
         message = NULLIF(btrim(COALESCE(p_message, '')), ''),
         terms = COALESCE(p_terms, '{}'::jsonb),
         pricing = COALESCE(p_pricing, '{}'::jsonb),
         responded_at = now(),
         expires_at = p_expires_at,
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_offer.id;

  UPDATE public.marketplace_requests
     SET status = 'negotiation',
         updated_at = now()
   WHERE id = v_req.id;

  PERFORM public.marketplace_append_event_v1(
    v_org_id,
    'marketplace_offer',
    v_offer.id,
    'offer.countered',
    jsonb_build_object('request_id', v_req.id)
  );

  RETURN jsonb_build_object('ok', TRUE, 'id', v_offer.id, 'status', 'countered');
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

  IF v_req.status NOT IN ('published', 'negotiation') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_open'));
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
     SET status = 'awarded',
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
    settlement_mode_key = EXCLUDED.settlement_mode_key,
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
  v_kind public.marketplace_request_kinds%ROWTYPE;
  v_offer public.marketplace_offers%ROWTYPE;
  v_contract public.marketplace_contracts%ROWTYPE;
  v_work_package_id UUID := NULL;
  v_materializer_config JSONB := '{}'::jsonb;
  v_auto_materialize BOOLEAN := FALSE;
  v_materialize_result JSONB := '{}'::jsonb;
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
  SELECT * INTO v_kind FROM public.marketplace_request_kinds WHERE kind_key = v_req.request_kind_key LIMIT 1;
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
       SET status = CASE
             WHEN EXISTS (
               SELECT 1
                 FROM public.marketplace_offers o
                WHERE o.request_id = v_award.request_id
                  AND o.id <> v_offer.id
                  AND o.status IN ('submitted', 'countered')
             ) THEN 'negotiation'
             ELSE 'published'
           END,
           awarded_offer_id = NULL,
           updated_at = now()
     WHERE id = v_award.request_id;

    UPDATE public.marketplace_offers
       SET status = 'rejected',
           responded_at = now(),
           metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           updated_at = now()
     WHERE id = v_award.offer_id;

    PERFORM public.marketplace_append_reputation_event_v1(
      v_award.supplier_participant_profile_id,
      'award_rejected',
      'cancellation_rate',
      -1,
      1,
      'marketplace_award',
      v_award.id,
      jsonb_build_object('status', 'rejected')
    );

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
     SET status = 'provider_accepted',
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
    COALESCE(v_req.materializer_key, v_req.request_kind_key, 'manual_bridge'),
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

  v_materializer_config := public.marketplace_materializer_config_v1(COALESCE(v_req.materializer_key, 'manual_bridge'));
  v_auto_materialize := COALESCE((v_kind.lifecycle_config->>'auto_materialize_on_provider_accept')::boolean, FALSE)
    OR COALESCE((v_materializer_config->>'auto_materialize_on_provider_accept')::boolean, FALSE)
    OR COALESCE((public.marketplace_execution_policy_v1(
         jsonb_build_object('organization_id', v_req.requester_organization_id, 'request_kind_key', v_req.request_kind_key)
       )->'work_package'->>'auto_materialize_on_provider_accept')::boolean, FALSE);

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

  IF v_auto_materialize THEN
    v_materialize_result := public.marketplace_work_package_materialize_v1(
      p_work_package_id := v_work_package_id,
      p_award_id := NULL,
      p_execution_ref := jsonb_build_object('auto_materialized', TRUE),
      p_summary := jsonb_build_object('auto_materialized', TRUE),
      p_metadata := jsonb_build_object('source', 'award_respond.auto_materialize') || COALESCE(p_metadata, '{}'::jsonb)
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_award.id,
    'status', 'accepted',
    'work_package_id', v_work_package_id,
    'materialize', COALESCE(v_materialize_result, '{}'::jsonb)
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
  v_wp_status TEXT := 'materialized';
  v_request_status TEXT := 'materialized';
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_work_packages', 'write')
     AND NOT public.user_has_resource_capability_v1('marketplace_awards', 'write') THEN
    RAISE EXCEPTION 'marketplace_work_packages.write capability required' USING ERRCODE = '42501';
  END IF;

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

  v_materializer := public.marketplace_materializer_config_v1(v_wp.materializer_key);
  v_execution_target := COALESCE(NULLIF(v_materializer->>'execution_target', ''), 'manual');

  IF v_execution_target = 'manual' THEN
    v_materialization_state := 'manual';
    v_wp_status := 'materialized';
    v_request_status := 'materialized';
  ELSE
    v_materialization_state := 'materialized';
    v_wp_status := 'executing';
    v_request_status := 'executing';
  END IF;

  UPDATE public.marketplace_work_packages
     SET materialization_state = v_materialization_state,
         status = v_wp_status,
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

  UPDATE public.marketplace_contracts
     SET status = CASE WHEN v_wp_status = 'executing' THEN 'executing' ELSE 'materialized' END,
         updated_at = now()
   WHERE id = v_wp.contract_id;

  UPDATE public.marketplace_requests
     SET status = v_request_status,
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
    'status', v_wp_status,
    'materialization_state', v_materialization_state,
    'execution_target', v_execution_target
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_offer_counter_v1(UUID, TEXT, JSONB, JSONB, TIMESTAMPTZ, JSONB) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603081210_marketplace_network_offer_award_v1'));
COMMIT;
