-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace network completion, settlement, and application-status flows

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081230_marketplace_network_settlement_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_settlement_finalize_v1(
  p_work_package_id UUID DEFAULT NULL,
  p_contract_id UUID DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_wp public.marketplace_work_packages%ROWTYPE;
  v_contract public.marketplace_contracts%ROWTYPE;
  v_award public.marketplace_awards%ROWTYPE;
  v_offer public.marketplace_offers%ROWTYPE;
  v_request public.marketplace_requests%ROWTYPE;
  v_amount NUMERIC := NULL;
  v_currency TEXT := 'SAR';
  v_requester_finance UUID;
  v_supplier_finance UUID;
  v_requester_finance_at TIMESTAMPTZ;
  v_supplier_finance_at TIMESTAMPTZ;
  v_requester_batch UUID;
  v_supplier_batch UUID;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL AND NOT v_is_platform THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'write') THEN
    RAISE EXCEPTION 'marketplace_contracts.write capability required' USING ERRCODE = '42501';
  END IF;

  IF p_work_package_id IS NULL AND p_contract_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_or_contract_required'));
  END IF;

  IF p_work_package_id IS NOT NULL THEN
    SELECT *
      INTO v_wp
      FROM public.marketplace_work_packages wp
     WHERE wp.id = p_work_package_id
       AND (
         v_is_platform
         OR wp.requester_organization_id = v_org_id
         OR wp.supplier_organization_id = v_org_id
       )
     FOR UPDATE;
  ELSE
    SELECT *
      INTO v_contract
      FROM public.marketplace_contracts c
     WHERE c.id = p_contract_id
       AND (
         v_is_platform
         OR c.requester_organization_id = v_org_id
         OR c.supplier_organization_id = v_org_id
       )
     FOR UPDATE;

    IF v_contract.id IS NOT NULL THEN
      SELECT *
        INTO v_wp
        FROM public.marketplace_work_packages wp
       WHERE wp.contract_id = v_contract.id
       LIMIT 1
       FOR UPDATE;
    END IF;
  END IF;

  IF v_wp.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_found'));
  END IF;

  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_wp.contract_id FOR UPDATE;
  SELECT * INTO v_award FROM public.marketplace_awards WHERE id = v_wp.award_id FOR UPDATE;
  SELECT * INTO v_offer FROM public.marketplace_offers WHERE id = v_award.offer_id FOR UPDATE;
  SELECT * INTO v_request FROM public.marketplace_requests WHERE id = v_wp.request_id FOR UPDATE;

  IF v_contract.settlement_mode_key <> 'auto_recorded_internal' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'settlement_mode_not_supported'));
  END IF;

  IF v_wp.status NOT IN ('completed', 'settled') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_ready_for_settlement'));
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.marketplace_disputes d
     WHERE (d.contract_id = v_contract.id OR d.work_package_id = v_wp.id)
       AND d.status IN ('open', 'under_review')
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'open_dispute_exists'));
  END IF;

  IF v_wp.status = 'settled' AND v_contract.status = 'settled' AND v_request.status = 'settled' THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'id', v_wp.id,
      'status', 'settled',
      'already_settled', TRUE
    );
  END IF;

  BEGIN
    v_amount := COALESCE(
      NULLIF(v_offer.pricing->>'amount', '')::numeric,
      NULLIF(v_award.award_terms->>'amount', '')::numeric,
      NULLIF(v_contract.terms->>'amount', '')::numeric,
      NULLIF(v_request.request_details->>'amount', '')::numeric,
      NULLIF(v_request.request_details->>'budget_amount', '')::numeric
    );
  EXCEPTION
    WHEN others THEN
      v_amount := NULL;
  END;

  v_currency := COALESCE(
    NULLIF(v_offer.pricing->>'currency', ''),
    NULLIF(v_award.award_terms->>'currency', ''),
    NULLIF(v_contract.terms->>'currency', ''),
    NULLIF(v_request.request_details->>'currency', ''),
    'SAR'
  );

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'settlement_amount_missing'));
  END IF;

  SELECT finance_event_id, occurred_at
    INTO v_requester_finance, v_requester_finance_at
    FROM public.marketplace_record_finance_event_v1(
      p_organization_id := v_contract.requester_organization_id,
      p_event_type := 'marketplace_payable_recorded',
      p_direction := 'debit',
      p_amount := v_amount,
      p_currency := v_currency,
      p_subject_type := 'marketplace_contract',
      p_subject_id := v_contract.id,
      p_metadata := jsonb_build_object(
        'marketplace_contract_id', v_contract.id,
        'marketplace_work_package_id', v_wp.id,
        'counterparty_organization_id', v_contract.supplier_organization_id,
        'role', 'requester'
      ) || COALESCE(p_metadata, '{}'::jsonb),
      p_idempotency_key := format('marketplace:%s:requester:settlement', v_wp.id)
    );

  SELECT finance_event_id, occurred_at
    INTO v_supplier_finance, v_supplier_finance_at
    FROM public.marketplace_record_finance_event_v1(
      p_organization_id := v_contract.supplier_organization_id,
      p_event_type := 'marketplace_receivable_recorded',
      p_direction := 'credit',
      p_amount := v_amount,
      p_currency := v_currency,
      p_subject_type := 'marketplace_contract',
      p_subject_id := v_contract.id,
      p_metadata := jsonb_build_object(
        'marketplace_contract_id', v_contract.id,
        'marketplace_work_package_id', v_wp.id,
        'counterparty_organization_id', v_contract.requester_organization_id,
        'role', 'supplier'
      ) || COALESCE(p_metadata, '{}'::jsonb),
      p_idempotency_key := format('marketplace:%s:supplier:settlement', v_wp.id)
    );

  v_requester_batch := public.marketplace_create_posted_settlement_batch_v1(
    p_organization_id := v_contract.requester_organization_id,
    p_kind := 'billing',
    p_subject_id := v_contract.id,
    p_finance_event_id := v_requester_finance,
    p_finance_occurred_at := v_requester_finance_at,
    p_metadata := jsonb_build_object(
      'marketplace_contract_id', v_contract.id,
      'marketplace_work_package_id', v_wp.id,
      'direction', 'debit'
    ) || COALESCE(p_metadata, '{}'::jsonb),
    p_idempotency_key := format('marketplace:%s:requester:settlement:billing_batch', v_wp.id)
  );

  v_supplier_batch := public.marketplace_create_posted_settlement_batch_v1(
    p_organization_id := v_contract.supplier_organization_id,
    p_kind := 'payout',
    p_subject_id := v_contract.id,
    p_finance_event_id := v_supplier_finance,
    p_finance_occurred_at := v_supplier_finance_at,
    p_metadata := jsonb_build_object(
      'marketplace_contract_id', v_contract.id,
      'marketplace_work_package_id', v_wp.id,
      'direction', 'credit'
    ) || COALESCE(p_metadata, '{}'::jsonb),
    p_idempotency_key := format('marketplace:%s:supplier:settlement:payout_batch', v_wp.id)
  );

  UPDATE public.marketplace_work_packages
     SET status = 'settled',
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement}',
           COALESCE(metadata->'settlement', '{}'::jsonb) || jsonb_build_object(
             'settled_at', now(),
             'requester_finance_event_id', v_requester_finance,
             'supplier_finance_event_id', v_supplier_finance,
             'requester_settlement_batch_id', v_requester_batch,
             'supplier_settlement_batch_id', v_supplier_batch,
             'amount', v_amount,
             'currency', v_currency
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_wp.id;

  UPDATE public.marketplace_contracts
     SET status = 'settled',
         completed_at = COALESCE(completed_at, now()),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement}',
           COALESCE(metadata->'settlement', '{}'::jsonb) || jsonb_build_object(
             'settled_at', now(),
             'amount', v_amount,
             'currency', v_currency
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_contract.id;

  UPDATE public.marketplace_requests
     SET status = 'settled',
         closed_at = COALESCE(closed_at, now()),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement}',
           COALESCE(metadata->'settlement', '{}'::jsonb) || jsonb_build_object(
             'settled_at', now(),
             'amount', v_amount,
             'currency', v_currency
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_request.id;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(v_org_id, v_contract.requester_organization_id),
    'marketplace_work_package',
    v_wp.id,
    'settlement.finalized',
    jsonb_build_object(
      'requester_finance_event_id', v_requester_finance,
      'supplier_finance_event_id', v_supplier_finance
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_wp.id,
    'status', 'settled',
    'requester_finance_event_id', v_requester_finance,
    'supplier_finance_event_id', v_supplier_finance,
    'requester_settlement_batch_id', v_requester_batch,
    'supplier_settlement_batch_id', v_supplier_batch
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_settlement_reverse_v1(
  p_work_package_id UUID,
  p_reason TEXT DEFAULT NULL,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_wp public.marketplace_work_packages%ROWTYPE;
  v_contract public.marketplace_contracts%ROWTYPE;
  v_award public.marketplace_awards%ROWTYPE;
  v_offer public.marketplace_offers%ROWTYPE;
  v_request public.marketplace_requests%ROWTYPE;
  v_amount NUMERIC := NULL;
  v_currency TEXT := 'SAR';
  v_requester_finance UUID;
  v_supplier_finance UUID;
  v_requester_finance_at TIMESTAMPTZ;
  v_supplier_finance_at TIMESTAMPTZ;
  v_requester_batch UUID;
  v_supplier_batch UUID;
  v_reason TEXT := NULLIF(btrim(COALESCE(p_reason, '')), '');
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL AND NOT v_is_platform THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'write') THEN
    RAISE EXCEPTION 'marketplace_contracts.write capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_wp
    FROM public.marketplace_work_packages wp
   WHERE wp.id = p_work_package_id
     AND (
       v_is_platform
       OR wp.requester_organization_id = v_org_id
       OR wp.supplier_organization_id = v_org_id
     )
   FOR UPDATE;

  IF v_wp.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_found'));
  END IF;

  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_wp.contract_id FOR UPDATE;
  SELECT * INTO v_award FROM public.marketplace_awards WHERE id = v_wp.award_id FOR UPDATE;
  SELECT * INTO v_offer FROM public.marketplace_offers WHERE id = v_award.offer_id FOR UPDATE;
  SELECT * INTO v_request FROM public.marketplace_requests WHERE id = v_wp.request_id FOR UPDATE;

  IF v_wp.status <> 'settled' THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_settled'));
  END IF;

  BEGIN
    v_amount := COALESCE(
      NULLIF(v_offer.pricing->>'amount', '')::numeric,
      NULLIF(v_award.award_terms->>'amount', '')::numeric,
      NULLIF(v_contract.terms->>'amount', '')::numeric,
      NULLIF(v_request.request_details->>'amount', '')::numeric,
      NULLIF(v_request.request_details->>'budget_amount', '')::numeric
    );
  EXCEPTION
    WHEN others THEN
      v_amount := NULL;
  END;

  v_currency := COALESCE(
    NULLIF(v_offer.pricing->>'currency', ''),
    NULLIF(v_award.award_terms->>'currency', ''),
    NULLIF(v_contract.terms->>'currency', ''),
    NULLIF(v_request.request_details->>'currency', ''),
    'SAR'
  );

  IF v_amount IS NULL OR v_amount <= 0 THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'settlement_amount_missing'));
  END IF;

  SELECT finance_event_id, occurred_at
    INTO v_requester_finance, v_requester_finance_at
    FROM public.marketplace_record_finance_event_v1(
      p_organization_id := v_contract.requester_organization_id,
      p_event_type := 'marketplace_payable_reversal',
      p_direction := 'credit',
      p_amount := v_amount,
      p_currency := v_currency,
      p_subject_type := 'marketplace_contract',
      p_subject_id := v_contract.id,
      p_metadata := jsonb_build_object(
        'marketplace_contract_id', v_contract.id,
        'marketplace_work_package_id', v_wp.id,
        'reason', v_reason,
        'role', 'requester'
      ) || COALESCE(p_metadata, '{}'::jsonb),
      p_idempotency_key := format('marketplace:%s:requester:settlement_reversal', v_wp.id)
    );

  SELECT finance_event_id, occurred_at
    INTO v_supplier_finance, v_supplier_finance_at
    FROM public.marketplace_record_finance_event_v1(
      p_organization_id := v_contract.supplier_organization_id,
      p_event_type := 'marketplace_receivable_reversal',
      p_direction := 'debit',
      p_amount := v_amount,
      p_currency := v_currency,
      p_subject_type := 'marketplace_contract',
      p_subject_id := v_contract.id,
      p_metadata := jsonb_build_object(
        'marketplace_contract_id', v_contract.id,
        'marketplace_work_package_id', v_wp.id,
        'reason', v_reason,
        'role', 'supplier'
      ) || COALESCE(p_metadata, '{}'::jsonb),
      p_idempotency_key := format('marketplace:%s:supplier:settlement_reversal', v_wp.id)
    );

  v_requester_batch := public.marketplace_create_posted_settlement_batch_v1(
    p_organization_id := v_contract.requester_organization_id,
    p_kind := 'billing',
    p_subject_id := v_contract.id,
    p_finance_event_id := v_requester_finance,
    p_finance_occurred_at := v_requester_finance_at,
    p_metadata := jsonb_build_object(
      'marketplace_contract_id', v_contract.id,
      'marketplace_work_package_id', v_wp.id,
      'direction', 'credit',
      'reason', v_reason
    ) || COALESCE(p_metadata, '{}'::jsonb),
    p_idempotency_key := format('marketplace:%s:requester:settlement_reversal:billing_batch', v_wp.id)
  );

  v_supplier_batch := public.marketplace_create_posted_settlement_batch_v1(
    p_organization_id := v_contract.supplier_organization_id,
    p_kind := 'payout',
    p_subject_id := v_contract.id,
    p_finance_event_id := v_supplier_finance,
    p_finance_occurred_at := v_supplier_finance_at,
    p_metadata := jsonb_build_object(
      'marketplace_contract_id', v_contract.id,
      'marketplace_work_package_id', v_wp.id,
      'direction', 'debit',
      'reason', v_reason
    ) || COALESCE(p_metadata, '{}'::jsonb),
    p_idempotency_key := format('marketplace:%s:supplier:settlement_reversal:payout_batch', v_wp.id)
  );

  UPDATE public.marketplace_work_packages
     SET status = 'completed',
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement_reversal}',
           COALESCE(metadata->'settlement_reversal', '{}'::jsonb) || jsonb_build_object(
             'reversed_at', now(),
             'requester_finance_event_id', v_requester_finance,
             'supplier_finance_event_id', v_supplier_finance,
             'requester_settlement_batch_id', v_requester_batch,
             'supplier_settlement_batch_id', v_supplier_batch,
             'reason', v_reason
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_wp.id;

  UPDATE public.marketplace_contracts
     SET status = 'completed',
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement_reversal}',
           COALESCE(metadata->'settlement_reversal', '{}'::jsonb) || jsonb_build_object(
             'reversed_at', now(),
             'reason', v_reason
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_contract.id;

  UPDATE public.marketplace_requests
     SET status = 'completed',
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{settlement_reversal}',
           COALESCE(metadata->'settlement_reversal', '{}'::jsonb) || jsonb_build_object(
             'reversed_at', now(),
             'reason', v_reason
           ),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_request.id;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(v_org_id, v_contract.requester_organization_id),
    'marketplace_work_package',
    v_wp.id,
    'settlement.reversed',
    jsonb_build_object(
      'requester_finance_event_id', v_requester_finance,
      'supplier_finance_event_id', v_supplier_finance
    )
  );

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_wp.id,
    'status', 'completed',
    'requester_finance_event_id', v_requester_finance,
    'supplier_finance_event_id', v_supplier_finance,
    'requester_settlement_batch_id', v_requester_batch,
    'supplier_settlement_batch_id', v_supplier_batch
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_work_package_complete_v1(
  p_work_package_id UUID,
  p_proof JSONB DEFAULT '{}'::jsonb,
  p_metadata JSONB DEFAULT '{}'::jsonb
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_wp public.marketplace_work_packages%ROWTYPE;
  v_contract public.marketplace_contracts%ROWTYPE;
  v_request public.marketplace_requests%ROWTYPE;
  v_status TEXT := 'completed';
  v_settlement_result JSONB := '{}'::jsonb;
  v_proof_quality NUMERIC := NULL;
  v_feedback_score NUMERIC := NULL;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF v_org_id IS NULL AND NOT v_is_platform THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_work_packages', 'write')
     AND NOT public.user_has_resource_capability_v1('marketplace_contracts', 'write') THEN
    RAISE EXCEPTION 'marketplace_work_packages.write capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_wp
    FROM public.marketplace_work_packages wp
   WHERE wp.id = p_work_package_id
     AND (
       v_is_platform
       OR wp.requester_organization_id = v_org_id
       OR wp.supplier_organization_id = v_org_id
     )
   FOR UPDATE;

  IF v_wp.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_found'));
  END IF;

  IF v_wp.status IN ('completed', 'settled') THEN
    RETURN jsonb_build_object('ok', TRUE, 'id', v_wp.id, 'status', v_wp.status, 'already_processed', TRUE);
  END IF;

  IF EXISTS (
    SELECT 1
      FROM public.marketplace_disputes d
     WHERE d.work_package_id = v_wp.id
       AND d.status IN ('open', 'under_review')
  ) THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'open_dispute_exists'));
  END IF;

  IF v_wp.status NOT IN ('ready', 'materialized', 'executing', 'in_execution') THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_completable'));
  END IF;

  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_wp.contract_id FOR UPDATE;
  SELECT * INTO v_request FROM public.marketplace_requests WHERE id = v_wp.request_id FOR UPDATE;

  UPDATE public.marketplace_work_packages
     SET status = 'completed',
         completed_at = now(),
         metadata = jsonb_set(
           COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
           '{proof}',
           COALESCE(metadata->'proof', '{}'::jsonb) || COALESCE(p_proof, '{}'::jsonb),
           TRUE
         ),
         updated_at = now()
   WHERE id = v_wp.id;

  UPDATE public.marketplace_contracts
     SET status = 'completed',
         completed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_contract.id;

  UPDATE public.marketplace_requests
     SET status = 'completed',
         closed_at = now(),
         metadata = COALESCE(metadata, '{}'::jsonb) || COALESCE(p_metadata, '{}'::jsonb),
         updated_at = now()
   WHERE id = v_request.id;

  BEGIN
    v_proof_quality := NULLIF(COALESCE(p_proof->>'proof_quality', ''), '')::numeric;
  EXCEPTION
    WHEN others THEN
      v_proof_quality := NULL;
  END;

  BEGIN
    v_feedback_score := NULLIF(COALESCE(p_proof->>'feedback_score', ''), '')::numeric;
  EXCEPTION
    WHEN others THEN
      v_feedback_score := NULL;
  END;

  PERFORM public.marketplace_append_reputation_event_v1(
    v_wp.supplier_participant_profile_id,
    'delivery_completed',
    'completion_rate',
    1,
    1,
    'marketplace_work_package',
    v_wp.id,
    jsonb_build_object('contract_id', v_contract.id)
  );

  IF v_proof_quality IS NOT NULL THEN
    PERFORM public.marketplace_append_reputation_event_v1(
      v_wp.supplier_participant_profile_id,
      'proof_submitted',
      'proof_quality',
      v_proof_quality,
      1,
      'marketplace_work_package',
      v_wp.id,
      jsonb_build_object('proof_quality', v_proof_quality)
    );
  END IF;

  IF v_feedback_score IS NOT NULL THEN
    PERFORM public.marketplace_append_reputation_event_v1(
      v_wp.supplier_participant_profile_id,
      'feedback_recorded',
      'feedback_score',
      v_feedback_score,
      1,
      'marketplace_work_package',
      v_wp.id,
      jsonb_build_object('feedback_score', v_feedback_score)
    );
  END IF;

  PERFORM public.marketplace_append_event_v1(
    COALESCE(v_org_id, v_wp.requester_organization_id),
    'marketplace_work_package',
    v_wp.id,
    'work_package.completed',
    jsonb_build_object('contract_id', v_contract.id)
  );

  IF v_contract.settlement_mode_key = 'auto_recorded_internal' THEN
    v_settlement_result := public.marketplace_settlement_finalize_v1(
      p_work_package_id := v_wp.id,
      p_contract_id := v_contract.id,
      p_metadata := jsonb_build_object('source', 'work_package_complete') || COALESCE(p_metadata, '{}'::jsonb)
    );

    IF COALESCE(v_settlement_result->>'status', '') = 'settled' THEN
      v_status := 'settled';
    END IF;
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_wp.id,
    'status', v_status,
    'settlement', COALESCE(v_settlement_result, '{}'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_application_status_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_req public.marketplace_participant_requests%ROWTYPE;
  v_state TEXT := 'pending_review';
BEGIN
  SELECT *
    INTO v_req
    FROM public.marketplace_participant_requests r
   WHERE r.id = p_request_id
   LIMIT 1;

  IF v_req.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  IF v_req.status = 'approved' THEN
    v_state := CASE
      WHEN COALESCE(v_req.last_error_code, '') = 'reverification_required' THEN 'reverification_required'
      ELSE 'approved'
    END;
  ELSIF v_req.status = 'rejected' THEN
    v_state := 'rejected';
  ELSE
    v_state := 'pending_review';
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'id', v_req.id,
    'status', v_req.status,
    'application_state', v_state,
    'participant_type_key', v_req.requested_participant_type_key,
    'review_decision', v_req.review_decision,
    'reviewed_at', v_req.reviewed_at,
    'invite_email_sent_at', v_req.invite_email_sent_at
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_work_package_complete_v1(UUID, JSONB, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_settlement_finalize_v1(UUID, UUID, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_settlement_reverse_v1(UUID, TEXT, JSONB) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_application_status_v1(UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603081230_marketplace_network_settlement_v1'));
COMMIT;
