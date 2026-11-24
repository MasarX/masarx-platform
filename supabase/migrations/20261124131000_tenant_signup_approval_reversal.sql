BEGIN;
SET LOCAL search_path TO public, extensions, pg_temp;

ALTER TABLE public.tenant_signup_requests
  ADD COLUMN approval_provisioning_recorded boolean NOT NULL DEFAULT false,
  ADD COLUMN approval_created_organization_id uuid,
  ADD COLUMN approval_created_user_id uuid,
  ADD COLUMN approval_created_role_assignment_id uuid;

COMMENT ON COLUMN public.tenant_signup_requests.approval_created_organization_id IS
  'Organization inserted by this approval. NULL for linked organizations and approvals without recorded provenance.';

DO $provenance$
DECLARE
  definition text := pg_get_functiondef(
    'public.tenant_signup_review_apply_v1_impl_202605031930(uuid,text,uuid,text,uuid,boolean,text,jsonb)'::regprocedure
  );
  declaration constant text := 'v_role_id UUID := NULL;';
  user_insert constant text := 'RETURNING id INTO v_user_id;';
  role_metadata constant text := $sql$'request_id', v_req.id
          )
        )
        ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL
        DO UPDATE SET
          metadata = public.rbac_user_role_assignments.metadata || EXCLUDED.metadata,
          updated_at = now();$sql$;
  role_insert constant text := $sql$'request_id', v_req.id,
            'signup_created_by_request_id', v_req.id
          )
        )
        ON CONFLICT (organization_id, user_id, role_id) WHERE revoked_at IS NULL
        DO UPDATE SET
          metadata = public.rbac_user_role_assignments.metadata || (EXCLUDED.metadata - 'signup_created_by_request_id'),
          updated_at = now()
        RETURNING CASE WHEN metadata->>'signup_created_by_request_id' = v_req.id::text THEN id END
          INTO v_approval_created_role_assignment_id;$sql$;
  approval_update constant text := 'approved_organization_id = v_org_id,';
  anchor text;
BEGIN
  FOREACH anchor IN ARRAY ARRAY[declaration, user_insert, role_metadata, approval_update] LOOP
    IF cardinality(string_to_array(definition, anchor)) <> 2 THEN
      RAISE EXCEPTION 'Unexpected tenant signup approval body while recording provisioning provenance';
    END IF;
  END LOOP;
  -- The approval reversal pgTAP cases verify each of these provenance writes.
  definition := replace(definition, declaration, declaration || $sql$
  v_approval_created_user_id UUID;
  v_approval_created_role_assignment_id UUID;$sql$);
  definition := replace(definition, user_insert, user_insert || $sql$
      v_approval_created_user_id := v_user_id;$sql$);
  definition := replace(definition, role_metadata, role_insert);
  EXECUTE replace(definition, approval_update, approval_update || $sql$
         approval_provisioning_recorded = TRUE,
         approval_created_organization_id = CASE
           WHEN v_provision_on_approval AND NOT v_existing_org_linked THEN v_org_id
           ELSE NULL
         END,
         approval_created_user_id = v_approval_created_user_id,
         approval_created_role_assignment_id = v_approval_created_role_assignment_id,$sql$);
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
ON CONFLICT (lookup_definition_id, value) DO UPDATE SET status = EXCLUDED.status
WHERE public.lookup_values.status IS DISTINCT FROM EXCLUDED.status;

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
  user_deactivated boolean := false;
  role_revoked boolean := false;
  organization_provenance text;
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
  IF NOT request_row.approval_provisioning_recorded THEN
    RETURN jsonb_build_object('ok', false, 'error', jsonb_build_object('code', 'reversal_provenance_unavailable'));
  END IF;

  UPDATE public.users SET status = 'suspended', updated_at = reversed_at
  WHERE id = request_row.approval_created_user_id AND organization_id = request_row.approved_organization_id
    AND status = 'active';
  user_deactivated := FOUND;
  UPDATE public.rbac_user_role_assignments SET revoked_at = reversed_at, updated_at = reversed_at
  WHERE id = request_row.approval_created_role_assignment_id AND organization_id = request_row.approved_organization_id
    AND user_id = request_row.approved_user_id AND revoked_at IS NULL;
  role_revoked := FOUND;

  IF request_row.approval_created_organization_id = request_row.approved_organization_id THEN
    UPDATE public.organizations
    SET billing_status = 'suspended', updated_at = reversed_at
    WHERE id = request_row.approval_created_organization_id AND billing_status <> 'suspended';
    suspended := FOUND;
  END IF;

  organization_provenance := CASE
    WHEN request_row.approved_organization_id IS NULL THEN 'unprovisioned'
    WHEN request_row.approval_created_organization_id = request_row.approved_organization_id THEN 'created'
    ELSE 'linked'
  END;
  decision_id := public.log_decision(
    COALESCE(request_row.approved_organization_id, public.marketplace_system_org_id_v1()),
    'tenant_signup_review', 'tenant_signup_request', request_row.id,
    'approval_reversal', 'reversed', 'tenant_signup_review_reverse_v1', public.current_correlation_id(),
    jsonb_build_object('reason', reason, 'organization_provenance', organization_provenance,
      'organization_suspended', suspended, 'user_deactivated', user_deactivated, 'role_revoked', role_revoked)
  );
  evidence := jsonb_build_object(
    'ok', true, 'id', request_row.id, 'status', 'reversed',
    'organization_suspended', suspended, 'user_deactivated', user_deactivated,
    'role_revoked', role_revoked, 'decision_log_id', decision_id
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
