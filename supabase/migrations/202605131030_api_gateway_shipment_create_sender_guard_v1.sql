-- Console V2 first-tenant readiness: API Gateway shipment-create intake must
-- fail closed unless the source resolves to an active sender/client context.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605131030_api_gateway_shipment_create_sender_guard_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.api_gateway_route_canonical_intent_v1(
  p_policy jsonb
)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_intent text;
BEGIN
  v_intent := lower(NULLIF(btrim(COALESCE(
    p_policy #>> '{workflow,intent}',
    p_policy #>> '{workflow,canonical_intent}',
    p_policy #>> '{postprocess,canonical_intent}',
    p_policy #>> '{postprocess,intent}',
    p_policy #>> '{intake,canonical_intent}',
    p_policy #>> '{intake,intent}',
    p_policy ->> 'canonical_intent'
  )), ''));

  IF v_intent IN ('shipment_create', 'shipment.created', 'shipments.create') THEN
    RETURN 'shipment.create';
  END IF;

  IF v_intent IS NULL
     AND COALESCE(p_policy #>> '{postprocess,mode}', '') = 'shipment_create_v1' THEN
    RETURN 'shipment.create';
  END IF;

  RETURN v_intent;
END;
$function$;

COMMENT ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb)
  IS 'Resolves a row-driven API Gateway route intent from policy JSON so shipment-create guards do not depend on path literals.';

REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb) TO service_role, edge_api_gateway_role;

-- Backfill the canonical Logestechs shipment-create route with an explicit
-- row-driven workflow intent. Runtime guard logic reads this policy value
-- instead of matching provider paths.
UPDATE public.api_routes
   SET policy = jsonb_set(
         COALESCE(policy, '{}'::jsonb),
         '{workflow,intent}',
         to_jsonb('shipment.create'::text),
         TRUE
       ),
       updated_at = now()
 WHERE enabled = TRUE
   AND COALESCE(policy #>> '{postprocess,mode}', '') = 'shipment_create_v1'
   AND COALESCE(policy #>> '{workflow,intent}', '') = '';

DO $patch$
DECLARE
  v_def text;
  v_new text;
  v_declare_marker text := $marker$  v_workflow_context JSONB;
BEGIN$marker$;
  v_declare_replacement text := $replacement$  v_workflow_context JSONB;

  v_route_intent TEXT;
  v_source_binding_ok BOOLEAN;
BEGIN$replacement$;
  v_guard_marker text := $marker$  v_provider_account_policy := COALESCE(v_policy->'provider_account', '{}'::jsonb);
$marker$;
  v_guard_replacement text := $replacement$  v_route_intent := public.api_gateway_route_canonical_intent_v1(v_policy);

  IF v_route_intent = 'shipment.create' THEN
    SELECT EXISTS (
      SELECT 1
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender
         AND c.id = v_client
         AND c.organization_id = v_org
         AND COALESCE(s.status, 'active') = 'active'
         AND COALESCE(c.status, 'active') = 'active'
    )
      INTO v_source_binding_ok;

    IF COALESCE(v_source_binding_ok, FALSE) IS FALSE THEN
      PERFORM public.log_decision(
        p_organization_id := v_org,
        p_decision_category := 'settings_resolution',
        p_resource_type := 'webhook_source',
        p_resource_id := v_source.id,
        p_decision_point := 'api_gateway_source_sender_client_checked',
        p_decision_outcome := 'rejected',
        p_performed_by_system := 'api_gateway',
        p_correlation_id := v_corr,
        p_decision_inputs := jsonb_strip_nulls(jsonb_build_object(
          'method', v_method,
          'path', v_path,
          'route_id', v_route_id,
          'route_name', v_route_row.route_name,
          'canonical_intent', v_route_intent,
          'source_id', v_source.id,
          'sender_id', v_sender,
          'client_id', v_client
        )),
        p_decision_reason := 'API Gateway shipment-create source must be bound to an active sender/client before intake can create shipment workflow state.'
      );

      RETURN jsonb_build_object(
        'action', 'error',
        'status', 400,
        'headers', jsonb_build_object('content-type', 'application/json'),
        'body', jsonb_build_object(
          'error', 'api_gateway_source_missing_sender_client',
          'source_identifier', v_source.source_identifier
        ),
        'correlation_id', v_corr
      );
    END IF;
  END IF;

  v_provider_account_policy := COALESCE(v_policy->'provider_account', '{}'::jsonb);
$replacement$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position('api_gateway_source_missing_sender_client' IN v_def) > 0
     AND position($old_category$p_decision_category := 'api_gateway_intake'$old_category$ IN v_def) > 0 THEN
    EXECUTE replace(
      v_def,
      $old_category$p_decision_category := 'api_gateway_intake'$old_category$,
      $new_category$p_decision_category := 'settings_resolution'$new_category$
    );
    RAISE NOTICE 'workflow_intake_api_gateway_v1 API Gateway shipment-create guard decision category repaired';
    RETURN;
  END IF;

  IF position('api_gateway_source_missing_sender_client' IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already has API Gateway shipment-create sender/client guard';
    RETURN;
  END IF;

  IF position(v_declare_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected workflow context declaration marker not found in workflow_intake_api_gateway_v1';
  END IF;

  IF position(v_guard_marker IN v_def) = 0 THEN
    RAISE EXCEPTION 'Expected provider-account policy marker not found in workflow_intake_api_gateway_v1';
  END IF;

  v_new := replace(v_def, v_declare_marker, v_declare_replacement);
  v_new := replace(v_new, v_guard_marker, v_guard_replacement);
  EXECUTE v_new;
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'API Gateway intake: resolve row-driven routes/provider accounts, fail closed for shipment-create sources missing active sender/client binding, persist redacted request, queue outbound dispatch, or start workflow mode.';

REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM anon;
REVOKE EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO edge_api_gateway_role;
GRANT EXECUTE ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB) TO service_role;

SELECT pg_advisory_unlock(hashtext('202605131030_api_gateway_shipment_create_sender_guard_v1'));

COMMIT;
