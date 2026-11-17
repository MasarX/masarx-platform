-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Include contract identifiers in marketplace award responses

BEGIN;
SELECT pg_advisory_lock(hashtext('202603091020_marketplace_award_response_contract_id_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

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
     WHERE award_id = v_award.id
     RETURNING * INTO v_contract;

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

    RETURN jsonb_build_object(
      'ok', TRUE,
      'id', v_award.id,
      'status', 'rejected',
      'contract_id', v_contract.id
    );
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
    'request_id', v_award.request_id,
    'contract_id', v_contract.id,
    'work_package_id', v_work_package_id,
    'materialize', COALESCE(v_materialize_result, '{}'::jsonb)
  );
END;
$function$;

SELECT pg_advisory_unlock(hashtext('202603091020_marketplace_award_response_contract_id_v1'));
COMMIT;
