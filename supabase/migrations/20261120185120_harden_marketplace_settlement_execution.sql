BEGIN;

REVOKE ALL ON FUNCTION public.marketplace_create_posted_settlement_batch_v1(uuid, text, uuid, uuid, timestamp with time zone, jsonb, text) FROM PUBLIC, anon, authenticated;

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

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'write') THEN
    RAISE EXCEPTION 'marketplace_contracts.write capability required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_contracts.write', 'tenant', v_org_id);

  IF p_work_package_id IS NULL AND p_contract_id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_or_contract_required'));
  END IF;

  IF p_work_package_id IS NOT NULL THEN
    SELECT *
      INTO v_wp
      FROM public.marketplace_work_packages wp
     WHERE wp.id = p_work_package_id
       AND (
         wp.requester_organization_id = v_org_id
         OR wp.supplier_organization_id = v_org_id
       )
     FOR UPDATE;
  ELSE
    SELECT *
      INTO v_contract
      FROM public.marketplace_contracts c
     WHERE c.id = p_contract_id
       AND (
         c.requester_organization_id = v_org_id
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
    IF v_contract.id IS NOT NULL THEN
      RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'work_package_not_found'));
    END IF;
    RAISE EXCEPTION 'settlement contract access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_wp.contract_id FOR UPDATE;
  IF v_contract.id IS NULL OR (
    v_org_id IS DISTINCT FROM v_contract.requester_organization_id
    AND v_org_id IS DISTINCT FROM v_contract.supplier_organization_id
  ) THEN
    RAISE EXCEPTION 'settlement contract access denied' USING ERRCODE = '42501';
  END IF;
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

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_tenant_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'write') THEN
    RAISE EXCEPTION 'marketplace_contracts.write capability required' USING ERRCODE = '42501';
  END IF;

  PERFORM public.assert_capability_v1('marketplace_contracts.write', 'tenant', v_org_id);

  SELECT *
    INTO v_wp
    FROM public.marketplace_work_packages wp
   WHERE wp.id = p_work_package_id
     AND (
       wp.requester_organization_id = v_org_id
       OR wp.supplier_organization_id = v_org_id
     )
   FOR UPDATE;

  IF v_wp.id IS NULL THEN
    RAISE EXCEPTION 'settlement contract access denied' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_contract FROM public.marketplace_contracts WHERE id = v_wp.contract_id FOR UPDATE;
  IF v_contract.id IS NULL OR (
    v_org_id IS DISTINCT FROM v_contract.requester_organization_id
    AND v_org_id IS DISTINCT FROM v_contract.supplier_organization_id
  ) THEN
    RAISE EXCEPTION 'settlement contract access denied' USING ERRCODE = '42501';
  END IF;
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

COMMIT;
