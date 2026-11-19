-- Migration: API Gateway shipment mutation intent guard
-- Purpose:
--   - Keep Console API Gateway tester route classification aligned with the
--     backend canonical route intent helper.
--   - Apply the existing sender/client binding guard to shipment update,
--     delete/cancel, reschedule, and typed update routes, not only creates.

SELECT pg_advisory_lock(hashtext('202605300650_api_gateway_mutation_intent_guard_v1'));

CREATE OR REPLACE FUNCTION public.api_gateway_route_canonical_intent_v1(p_policy jsonb)
RETURNS text
LANGUAGE plpgsql
IMMUTABLE
SET search_path TO public, extensions, pg_temp
AS $$
DECLARE
  v_intent text;
  v_mode text;
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

  IF v_intent IN ('shipment_update', 'shipment.updated', 'shipments.update', 'shipments.updated') THEN
    RETURN 'shipment.update';
  END IF;

  IF v_intent IN (
    'shipment_cancel',
    'shipment.canceled',
    'shipment.cancelled',
    'shipment.delete',
    'shipments.cancel',
    'shipments.canceled',
    'shipments.cancelled',
    'shipments.delete'
  ) THEN
    RETURN 'shipment.delete';
  END IF;

  IF v_intent IN ('shipment_reschedule', 'shipment.rescheduled', 'shipments.reschedule', 'shipments.rescheduled') THEN
    RETURN 'shipment.reschedule';
  END IF;

  IF v_intent IN ('shipments.update.status', 'shipment.update.status', 'shipment.status.update') THEN
    RETURN 'update.status';
  END IF;

  IF v_intent IN ('shipments.update.address', 'shipment.update.address', 'shipment.address.update') THEN
    RETURN 'update.address';
  END IF;

  IF v_intent IS NOT NULL THEN
    RETURN v_intent;
  END IF;

  v_mode := lower(COALESCE(p_policy #>> '{postprocess,mode}', ''));
  CASE v_mode
    WHEN 'shipment_create_v1' THEN RETURN 'shipment.create';
    WHEN 'shipment_update_v1' THEN RETURN 'shipment.update';
    WHEN 'shipment_update_status_v1' THEN RETURN 'update.status';
    WHEN 'shipment_update_address_v1' THEN RETURN 'update.address';
    WHEN 'shipment_update_geocode_v1' THEN RETURN 'update.geocode';
    WHEN 'shipment_update_driver_v1' THEN RETURN 'update.driver';
    WHEN 'shipment_update_action_v1' THEN RETURN 'update.action';
    WHEN 'shipment_update_attachment_v1' THEN RETURN 'update.attachment';
    WHEN 'shipment_cancel_v1' THEN RETURN 'shipment.delete';
    WHEN 'shipment_delete_v1' THEN RETURN 'shipment.delete';
    WHEN 'shipment_reschedule_v1' THEN RETURN 'shipment.reschedule';
    ELSE RETURN '';
  END CASE;
END;
$$;

COMMENT ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb)
  IS 'Normalizes API Gateway route policies into canonical shipment mutation intents for guards, workflow defaults, and Console tester parity.';

REVOKE ALL ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.api_gateway_route_canonical_intent_v1(jsonb) TO service_role, edge_api_gateway_role;

DO $patch$
DECLARE
  v_def text;
  v_expected text := 'IF v_route_intent = ''shipment.create'' THEN';
  v_replacement text := 'IF v_route_intent IN (''shipment.create'', ''shipment.update'', ''shipment.delete'', ''shipment.reschedule'')
     OR v_route_intent LIKE ''update.%'' THEN';
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_api_gateway_v1(text,text,text,text,jsonb,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR v_def = '' THEN
    RAISE EXCEPTION 'workflow_intake_api_gateway_v1 definition not found';
  END IF;

  IF position(v_replacement IN v_def) > 0 THEN
    RAISE NOTICE 'workflow_intake_api_gateway_v1 already guards shipment mutation routes';
  ELSIF position(v_expected IN v_def) > 0 THEN
    v_def := replace(v_def, v_expected, v_replacement);
    v_def := replace(
      v_def,
      'Preserve a redacted inbound request row even when the shipment-create',
      'Preserve a redacted inbound request row even when the shipment mutation'
    );
    v_def := replace(
      v_def,
      'API Gateway shipment-create source must be bound to an active sender/client before intake can create shipment workflow state.',
      'API Gateway shipment mutation source must be bound to an active sender/client before intake can mutate shipment workflow state.'
    );
    EXECUTE v_def;
  ELSE
    RAISE EXCEPTION 'Expected shipment-create source binding guard marker not found in workflow_intake_api_gateway_v1';
  END IF;
END;
$patch$;

COMMENT ON FUNCTION public.workflow_intake_api_gateway_v1(TEXT, TEXT, TEXT, TEXT, JSONB, JSONB)
  IS 'Validates API Gateway token, route, source binding, provider account, and workflow/proxy intake; shipment mutation routes require active sender/client binding before dispatch.';

SELECT pg_advisory_unlock(hashtext('202605300650_api_gateway_mutation_intent_guard_v1'));
