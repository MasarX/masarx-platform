BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

ALTER TABLE public.tenant_signup_requests
  ADD COLUMN approval_created_organization_id uuid;

COMMENT ON COLUMN public.tenant_signup_requests.approval_created_organization_id IS
  'Organization inserted by this approval. NULL for linked organizations and approvals without recorded provenance.';

DO $provenance$
DECLARE
  definition text := pg_get_functiondef(
    'public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)'::regprocedure
  );
  anchor constant text := 'approved_organization_id = v_org_id,';
BEGIN
  IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
    RAISE EXCEPTION 'Unexpected tenant signup approval write while recording organization provenance';
  END IF;
  EXECUTE replace(definition, anchor, anchor || $sql$
         approval_created_organization_id = CASE
           WHEN v_provision_on_approval AND NOT v_existing_org_linked THEN v_org_id
           ELSE NULL
         END,$sql$);
END;
$provenance$;

INSERT INTO public.lookup_values
  (lookup_definition_id, value, label, description, sort_order, is_default, status, metadata)
SELECT definition.id, entry.value, entry.label, entry.description, entry.sort_order, false, 'active',
  entry.metadata::jsonb
FROM public.lookup_definitions AS definition
JOIN (VALUES
  ('tenant_signup_request_status', 'reversed', 'Reversed', 'Approval reversed by a service operator', 40, '{"tone":"neutral"}'),
  ('tenant_signup_review_decision', 'reversed', 'Reversed', 'Explicit approval reversal decision', 30, '{}'),
  ('decision_category', 'tenant_signup_review', 'Tenant signup review', 'Tenant signup approval review decisions', 1940, '{}')
) AS entry(category, value, label, description, sort_order, metadata) ON entry.category = definition.category
ON CONFLICT (lookup_definition_id, value) DO NOTHING;

CREATE FUNCTION public.tenant_signup_review_reverse_v1(p_request_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  request_row public.tenant_signup_requests%ROWTYPE;
  reason text := NULLIF(btrim(p_reason), '');
  reversed_at timestamptz := statement_timestamp();
  evidence jsonb;
  decision_id uuid;
  suspended boolean := false;
BEGIN
  IF NOT public.request_role_is_service_claim_v1() THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'service_role_required'));
  END IF;

  SELECT * INTO request_row FROM public.tenant_signup_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'signup_request_not_found'));
  END IF;
  IF request_row.status = 'reversed' THEN
    RETURN COALESCE(request_row.decision_metadata->'approval_reversal'->'result',
      jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'reversal_evidence_unavailable')));
  END IF;
  IF request_row.status <> 'approved' OR reason IS NULL THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object(
      'code', CASE WHEN reason IS NULL THEN 'reversal_reason_required' ELSE 'signup_request_not_approved' END
    ));
  END IF;

  IF request_row.approval_created_organization_id = request_row.approved_organization_id THEN
    UPDATE public.organizations
    SET billing_status = 'suspended', updated_at = reversed_at
    WHERE id = request_row.approval_created_organization_id AND billing_status <> 'suspended';
    suspended := FOUND;
  END IF;

  IF request_row.approved_organization_id IS NOT NULL THEN
    decision_id := public.log_decision(
      request_row.approved_organization_id, 'tenant_signup_review', 'tenant_signup_request', request_row.id,
      'approval_reversal', 'reversed', 'tenant_signup_review_reverse_v1', public.current_correlation_id(),
      jsonb_build_object('organization_suspended', suspended)
    );
  END IF;
  evidence := jsonb_build_object(
    'ok', true, 'id', request_row.id, 'status', 'reversed',
    'organization_suspended', suspended, 'decision_log_id', decision_id
  );

  UPDATE public.tenant_signup_requests
  SET status = 'reversed', review_decision = 'reversed', updated_at = reversed_at,
      decision_metadata = COALESCE(decision_metadata, '{}'::jsonb) || jsonb_build_object(
        'approval_reversal', jsonb_build_object('at', reversed_at, 'reason', reason, 'result', evidence)
      )
  WHERE id = request_row.id;
  RETURN evidence;
END;
$function$;

CREATE FUNCTION api.tenant_signup_review_reverse_v1(p_request_id uuid, p_reason text)
RETURNS jsonb
LANGUAGE sql
SET search_path TO public, extensions, pg_temp
AS $function$
  SELECT public.tenant_signup_review_reverse_v1(p_request_id, p_reason);
$function$;

REVOKE ALL ON FUNCTION public.tenant_signup_review_reverse_v1(uuid,text)
  FROM PUBLIC, anon, authenticated, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.tenant_signup_review_reverse_v1(uuid,text) TO service_role;
REVOKE ALL ON FUNCTION api.tenant_signup_review_reverse_v1(uuid,text)
  FROM PUBLIC, anon, authenticated, edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION api.tenant_signup_review_reverse_v1(uuid,text) TO service_role;

COMMIT;
