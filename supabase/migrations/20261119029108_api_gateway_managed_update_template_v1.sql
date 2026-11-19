BEGIN;
SET LOCAL lock_timeout = '10s';

-- The typed default migration left existing generated update policies in place.
UPDATE public.api_routes r
SET policy = jsonb_set(r.policy, '{workflow,template_name}',
      to_jsonb(public.api_gateway_shipment_mutation_default_workflow_template_v1('shipment.update'))),
    updated_at = now()
WHERE r.enabled IS TRUE
  AND r.scope_type = 'global'
  AND public.api_gateway_route_canonical_intent_v1(r.policy) = 'shipment.update'
  AND r.policy->'workflow' = '{"enabled":true,"template_name":"api_gateway_shipment_update_default_v1"}'::jsonb;

COMMIT;
