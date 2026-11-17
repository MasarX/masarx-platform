-- Plan: PLAN-202603-marketplace-network-product-complete / Step: S04
-- Migration: Marketplace workspace/read-model RPCs

BEGIN;
SELECT pg_advisory_lock(hashtext('202603081250_marketplace_network_workspaces_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.marketplace_request_workspace_v1(
  p_request_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_request public.marketplace_requests%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_requests', 'read') THEN
    RAISE EXCEPTION 'marketplace_requests.read capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_request
    FROM public.marketplace_requests r
   WHERE r.id = p_request_id
     AND (
       v_is_platform
       OR public.marketplace_can_read_request_v1(r.id)
     )
   LIMIT 1;

  IF v_request.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'request_not_found'));
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'request', to_jsonb(v_request),
    'request_kind', (
      SELECT to_jsonb(rk)
        FROM public.marketplace_request_kinds rk
       WHERE rk.kind_key = v_request.request_kind_key
       LIMIT 1
    ),
    'offers', COALESCE((
      SELECT jsonb_agg(to_jsonb(o) ORDER BY o.submitted_at DESC, o.created_at DESC)
        FROM public.marketplace_offers o
       WHERE o.request_id = v_request.id
         AND (
           v_is_platform
           OR v_request.requester_organization_id = v_org_id
           OR o.supplier_organization_id = v_org_id
         )
    ), '[]'::jsonb),
    'awards', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC)
        FROM public.marketplace_awards a
       WHERE a.request_id = v_request.id
         AND (
           v_is_platform
           OR a.requester_organization_id = v_org_id
           OR a.supplier_organization_id = v_org_id
         )
    ), '[]'::jsonb),
    'contracts', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC)
        FROM public.marketplace_contracts c
       WHERE c.request_id = v_request.id
         AND (
           v_is_platform
           OR c.requester_organization_id = v_org_id
           OR c.supplier_organization_id = v_org_id
         )
    ), '[]'::jsonb),
    'work_packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(wp) ORDER BY wp.created_at DESC)
        FROM public.marketplace_work_packages wp
       WHERE wp.request_id = v_request.id
         AND (
           v_is_platform
           OR wp.requester_organization_id = v_org_id
           OR wp.supplier_organization_id = v_org_id
         )
    ), '[]'::jsonb),
    'disputes', COALESCE((
      SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC)
        FROM public.marketplace_disputes d
       WHERE d.request_id = v_request.id
         AND (
           v_is_platform
           OR d.opened_by_organization_id = v_org_id
           OR d.counterparty_organization_id = v_org_id
         )
    ), '[]'::jsonb),
    'private_pool_memberships', COALESCE((
      SELECT jsonb_agg(
               jsonb_build_object(
                 'request_id', v_request.id,
                 'supplier_organization_id', pool.value,
                 'requester_organization_id', v_request.requester_organization_id
               )
               ORDER BY pool.value
             )
        FROM jsonb_array_elements_text(COALESCE(v_request.private_pool, '[]'::jsonb)) AS pool(value)
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_provider_workboard_v1(
  p_include_closed BOOLEAN DEFAULT FALSE
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_profile public.marketplace_participant_profiles%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL OR v_org_id IS NULL THEN
    RAISE EXCEPTION 'authenticated_participant_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_offers', 'read') THEN
    RAISE EXCEPTION 'marketplace_offers.read capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_profile
    FROM public.marketplace_participant_profiles p
   WHERE p.organization_id = v_org_id
   ORDER BY p.created_at ASC
   LIMIT 1;

  IF v_profile.id IS NULL THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'participant_profile', NULL,
      'visible_requests', '[]'::jsonb,
      'offers', '[]'::jsonb,
      'awards', '[]'::jsonb,
      'contracts', '[]'::jsonb,
      'work_packages', '[]'::jsonb,
      'availability_windows', '[]'::jsonb
    );
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'participant_profile', to_jsonb(v_profile),
    'visible_requests', COALESCE((
      SELECT jsonb_agg(to_jsonb(r) ORDER BY r.published_at DESC NULLS LAST, r.created_at DESC)
        FROM public.marketplace_requests r
       WHERE public.marketplace_can_read_request_v1(r.id)
         AND (
           p_include_closed
           OR r.status NOT IN ('cancelled', 'expired', 'completed', 'settled')
         )
    ), '[]'::jsonb),
    'offers', COALESCE((
      SELECT jsonb_agg(to_jsonb(o) ORDER BY o.submitted_at DESC, o.created_at DESC)
        FROM public.marketplace_offers o
       WHERE o.supplier_organization_id = v_org_id
    ), '[]'::jsonb),
    'awards', COALESCE((
      SELECT jsonb_agg(to_jsonb(a) ORDER BY a.created_at DESC)
        FROM public.marketplace_awards a
       WHERE a.supplier_organization_id = v_org_id
    ), '[]'::jsonb),
    'contracts', COALESCE((
      SELECT jsonb_agg(to_jsonb(c) ORDER BY c.created_at DESC)
        FROM public.marketplace_contracts c
       WHERE c.supplier_organization_id = v_org_id
    ), '[]'::jsonb),
    'work_packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(wp) ORDER BY wp.created_at DESC)
        FROM public.marketplace_work_packages wp
       WHERE wp.supplier_organization_id = v_org_id
    ), '[]'::jsonb),
    'availability_windows', COALESCE((
      SELECT jsonb_agg(to_jsonb(aw) ORDER BY aw.starts_at DESC)
        FROM public.marketplace_availability_windows aw
       WHERE aw.participant_profile_id = v_profile.id
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_contract_room_v1(
  p_contract_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_contract public.marketplace_contracts%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'read') THEN
    RAISE EXCEPTION 'marketplace_contracts.read capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_contract
    FROM public.marketplace_contracts c
   WHERE c.id = p_contract_id
     AND (
       v_is_platform
       OR c.requester_organization_id = v_org_id
       OR c.supplier_organization_id = v_org_id
     )
   LIMIT 1;

  IF v_contract.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'contract_not_found'));
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'contract', to_jsonb(v_contract),
    'request', (
      SELECT to_jsonb(r)
        FROM public.marketplace_requests r
       WHERE r.id = v_contract.request_id
       LIMIT 1
    ),
    'award', (
      SELECT to_jsonb(a)
        FROM public.marketplace_awards a
       WHERE a.id = v_contract.award_id
       LIMIT 1
    ),
    'offer', (
      SELECT to_jsonb(o)
        FROM public.marketplace_offers o
       WHERE o.id = (
         SELECT a.offer_id
           FROM public.marketplace_awards a
          WHERE a.id = v_contract.award_id
          LIMIT 1
       )
       LIMIT 1
    ),
    'work_packages', COALESCE((
      SELECT jsonb_agg(to_jsonb(wp) ORDER BY wp.created_at DESC)
        FROM public.marketplace_work_packages wp
       WHERE wp.contract_id = v_contract.id
    ), '[]'::jsonb),
    'disputes', COALESCE((
      SELECT jsonb_agg(to_jsonb(d) ORDER BY d.created_at DESC)
        FROM public.marketplace_disputes d
       WHERE d.contract_id = v_contract.id
          OR d.work_package_id IN (
            SELECT wp.id
              FROM public.marketplace_work_packages wp
             WHERE wp.contract_id = v_contract.id
          )
    ), '[]'::jsonb),
    'settlements', COALESCE((
      SELECT jsonb_agg(to_jsonb(sb) ORDER BY sb.created_at DESC)
        FROM public.settlement_batches sb
       WHERE sb.scope_type = 'marketplace_contract'
         AND (
           sb.subject_id = v_contract.id
           OR sb.metadata->>'marketplace_contract_id' = v_contract.id::text
         )
         AND (
           v_is_platform
           OR sb.organization_id IN (v_contract.requester_organization_id, v_contract.supplier_organization_id)
         )
    ), '[]'::jsonb),
    'finance_events', COALESCE((
      SELECT jsonb_agg(to_jsonb(fe) ORDER BY fe.occurred_at DESC)
        FROM public.finance_events fe
       WHERE fe.subject_type = 'marketplace_contract'
         AND fe.subject_id = v_contract.id
         AND (
           v_is_platform
           OR fe.organization_id IN (v_contract.requester_organization_id, v_contract.supplier_organization_id)
         )
    ), '[]'::jsonb)
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_dispute_workspace_v1(
  p_dispute_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_dispute public.marketplace_disputes%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_disputes', 'read') THEN
    RAISE EXCEPTION 'marketplace_disputes.read capability required' USING ERRCODE = '42501';
  END IF;

  SELECT *
    INTO v_dispute
    FROM public.marketplace_disputes d
   WHERE d.id = p_dispute_id
     AND (
       v_is_platform
       OR d.opened_by_organization_id = v_org_id
       OR d.counterparty_organization_id = v_org_id
     )
   LIMIT 1;

  IF v_dispute.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'dispute_not_found'));
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'dispute', to_jsonb(v_dispute),
    'contract', (
      SELECT to_jsonb(c)
        FROM public.marketplace_contracts c
       WHERE c.id = v_dispute.contract_id
       LIMIT 1
    ),
    'work_package', (
      SELECT to_jsonb(wp)
        FROM public.marketplace_work_packages wp
       WHERE wp.id = v_dispute.work_package_id
       LIMIT 1
    ),
    'request', (
      SELECT to_jsonb(r)
        FROM public.marketplace_requests r
       WHERE r.id = v_dispute.request_id
       LIMIT 1
    )
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.marketplace_settlement_workspace_v1(
  p_contract_id UUID DEFAULT NULL,
  p_work_package_id UUID DEFAULT NULL
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_org_id UUID := public.current_user_org_id();
  v_is_platform BOOLEAN := public.is_platform_user();
  v_contract public.marketplace_contracts%ROWTYPE;
  v_work_package public.marketplace_work_packages%ROWTYPE;
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'authenticated_user_required' USING ERRCODE = '42501';
  END IF;

  IF NOT public.user_has_resource_capability_v1('marketplace_contracts', 'read') THEN
    RAISE EXCEPTION 'marketplace_contracts.read capability required' USING ERRCODE = '42501';
  END IF;

  IF p_work_package_id IS NOT NULL THEN
    SELECT *
      INTO v_work_package
      FROM public.marketplace_work_packages wp
     WHERE wp.id = p_work_package_id
       AND (
         v_is_platform
         OR wp.requester_organization_id = v_org_id
         OR wp.supplier_organization_id = v_org_id
       )
     LIMIT 1;

    IF v_work_package.id IS NOT NULL THEN
      SELECT *
        INTO v_contract
        FROM public.marketplace_contracts c
       WHERE c.id = v_work_package.contract_id
       LIMIT 1;
    END IF;
  END IF;

  IF v_contract.id IS NULL AND p_contract_id IS NOT NULL THEN
    SELECT *
      INTO v_contract
      FROM public.marketplace_contracts c
     WHERE c.id = p_contract_id
       AND (
         v_is_platform
         OR c.requester_organization_id = v_org_id
         OR c.supplier_organization_id = v_org_id
       )
     LIMIT 1;
  END IF;

  IF v_contract.id IS NULL THEN
    RETURN jsonb_build_object('ok', FALSE, 'error', jsonb_build_object('code', 'contract_not_found'));
  END IF;

  RETURN jsonb_build_object(
    'ok', TRUE,
    'contract', to_jsonb(v_contract),
    'work_package', CASE
      WHEN v_work_package.id IS NULL THEN NULL
      ELSE to_jsonb(v_work_package)
    END,
    'settlements', COALESCE((
      SELECT jsonb_agg(to_jsonb(sb) ORDER BY sb.created_at DESC)
        FROM public.settlement_batches sb
       WHERE sb.scope_type = 'marketplace_contract'
         AND (
           sb.subject_id = v_contract.id
           OR sb.metadata->>'marketplace_contract_id' = v_contract.id::text
           OR (
             v_work_package.id IS NOT NULL
             AND sb.metadata->>'marketplace_work_package_id' = v_work_package.id::text
           )
         )
         AND (
           v_is_platform
           OR sb.organization_id IN (v_contract.requester_organization_id, v_contract.supplier_organization_id)
         )
    ), '[]'::jsonb),
    'finance_events', COALESCE((
      SELECT jsonb_agg(to_jsonb(fe) ORDER BY fe.occurred_at DESC)
        FROM public.finance_events fe
       WHERE fe.subject_type = 'marketplace_contract'
         AND fe.subject_id = v_contract.id
         AND (
           v_is_platform
           OR fe.organization_id IN (v_contract.requester_organization_id, v_contract.supplier_organization_id)
         )
    ), '[]'::jsonb)
  );
END;
$function$;

GRANT EXECUTE ON FUNCTION public.marketplace_request_workspace_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_provider_workboard_v1(BOOLEAN) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_contract_room_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_dispute_workspace_v1(UUID) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.marketplace_settlement_workspace_v1(UUID, UUID) TO authenticated, service_role;

SELECT pg_advisory_unlock(hashtext('202603081250_marketplace_network_workspaces_v1'));
COMMIT;
