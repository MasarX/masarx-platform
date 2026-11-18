-- Console V2 first-tenant readiness: shipment-create webhook sources must be
-- sender/client scoped before they can be saved or accepted by receiver intake.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605091150_console_v2_webhook_shipment_sender_guard_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

CREATE OR REPLACE FUNCTION public.assert_webhook_source_shipment_sender_v1(
  p_mapping_config_id uuid,
  p_sender_id uuid
)
RETURNS void
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO public, extensions, pg_temp
AS $function$
DECLARE
  v_target text;
BEGIN
  SELECT NULLIF(btrim(mapping_config->>'target'), '')
    INTO v_target
    FROM public.mapping_configs
   WHERE id = p_mapping_config_id;

  IF v_target IN ('shipment.create', 'shipments.create') AND p_sender_id IS NULL THEN
    RAISE EXCEPTION 'shipment-create webhook sources require sender_id so receiver intake can resolve client scope'
      USING ERRCODE = '23502';
  END IF;
END;
$function$;

COMMENT ON FUNCTION public.assert_webhook_source_shipment_sender_v1(uuid, uuid)
  IS 'Fails closed when a webhook source mapped to shipment creation has no sender/client binding.';

REVOKE ALL ON FUNCTION public.assert_webhook_source_shipment_sender_v1(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.assert_webhook_source_shipment_sender_v1(uuid, uuid) TO authenticated, service_role;

DO $patch$
DECLARE
  v_def text;
  v_old_create text := $old$
    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    v_minted_token := encode(gen_random_bytes(32), 'hex');
$old$;
  v_new_create text := $new$
    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    PERFORM public.assert_webhook_source_shipment_sender_v1(v_mapping_config_id, v_sender_id);

    v_minted_token := encode(gen_random_bytes(32), 'hex');
$new$;
  v_old_update text := $old$
    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    UPDATE public.webhook_sources
$old$;
  v_new_update text := $new$
    IF v_sender_id IS NOT NULL THEN
      SELECT c.organization_id
        INTO v_sender_org
        FROM public.senders s
        JOIN public.clients c ON c.id = s.client_id
       WHERE s.id = v_sender_id;
      IF v_sender_org IS NULL THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % not found', v_sender_id
          USING ERRCODE = '23503';
      END IF;
      IF v_sender_org <> v_target_org THEN
        RAISE EXCEPTION 'ui_upsert_webhook_source_v1 sender % outside target organization', v_sender_id
          USING ERRCODE = '42501';
      END IF;
    END IF;

    PERFORM public.assert_webhook_source_shipment_sender_v1(
      COALESCE(v_mapping_config_id, v_before.mapping_config_id),
      CASE WHEN v_sender_id_present THEN v_sender_id ELSE v_before.sender_id END
    );

    UPDATE public.webhook_sources
$new$;
BEGIN
  SELECT pg_get_functiondef('public.ui_upsert_webhook_source_v1(jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'public.ui_upsert_webhook_source_v1(jsonb) definition not found';
  END IF;

  IF position(v_old_create IN v_def) = 0 THEN
    RAISE EXCEPTION 'expected create sender validation block not found in ui_upsert_webhook_source_v1';
  END IF;
  v_def := replace(v_def, v_old_create, v_new_create);

  IF position(v_old_update IN v_def) = 0 THEN
    RAISE EXCEPTION 'expected update sender validation block not found in ui_upsert_webhook_source_v1';
  END IF;
  v_def := replace(v_def, v_old_update, v_new_update);

  EXECUTE v_def;
END;
$patch$;

DO $patch$
DECLARE
  v_def text;
  v_old text := $old$
  IF v_canonical_intent IS NULL OR btrim(v_canonical_intent) = '' THEN
    v_canonical_intent := 'shipment.create';
  END IF;
  v_event_type := COALESCE(NULLIF(v_intent_resolution->>'event_type', ''), v_event_type, v_canonical_intent);
$old$;
  v_new text := $new$
  IF v_canonical_intent IS NULL OR btrim(v_canonical_intent) = '' THEN
    v_canonical_intent := 'shipment.create';
  END IF;

  IF v_canonical_intent IN ('shipment.create', 'shipments.create') AND v_source.client_id IS NULL THEN
    v_ack_reason := 'webhook source must be bound to shipment sender/client before shipment.create intake';
    RETURN jsonb_build_object(
      'status', v_bad_status,
      'headers', jsonb_build_object('content-type', 'application/json'),
      'body', jsonb_build_object(
        'error', v_ack_reason,
        'source_identifier', v_source.source_identifier
      ),
      'ack_outcome', 'ack_failed',
      'response_outcome', 'response_failed',
      'response_mode', v_ack_mode,
      'response_reason', 'webhook_source_missing_sender_client',
      'canonical_intent', v_canonical_intent
    );
  END IF;

  v_event_type := COALESCE(NULLIF(v_intent_resolution->>'event_type', ''), v_event_type, v_canonical_intent);
$new$;
BEGIN
  SELECT pg_get_functiondef('public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL OR btrim(v_def) = '' THEN
    RAISE EXCEPTION 'public.workflow_intake_webhook_core_v1(text,jsonb,text,jsonb) definition not found';
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'expected canonical intent block not found in workflow_intake_webhook_core_v1';
  END IF;

  v_def := replace(v_def, v_old, v_new);
  EXECUTE v_def;
END;
$patch$;

COMMENT ON FUNCTION public.ui_upsert_webhook_source_v1(jsonb)
  IS 'Canonical write RPC: insert/update public.webhook_sources, including required sender/client binding for shipment-create mappings. Capability: webhooks.write. On create, mints fresh auth_token returned once.';

COMMENT ON FUNCTION public.workflow_intake_webhook_core_v1(text, jsonb, text, jsonb)
  IS 'Core webhook intake entrypoint. Shipment-create intake fails closed until the webhook source is sender/client bound; workflow template selection stays row-driven through settings and source policy.';

SELECT pg_advisory_unlock(hashtext('202605091150_console_v2_webhook_shipment_sender_guard_v1'));
COMMIT;
