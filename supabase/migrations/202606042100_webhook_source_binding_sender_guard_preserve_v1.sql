-- Restore sender/client fail-closed behavior after webhook policy repair
-- reconciliation. The current repair helper must preserve ACK response mapping
-- while refusing shipment-create source policy repairs without an active sender
-- and client context.

BEGIN;

SELECT pg_advisory_lock(hashtext('202606042100_webhook_source_binding_sender_guard_preserve_v1'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_changed BOOLEAN := FALSE;
  v_canonical_marker TEXT := $marker$  IF v_canonical_intent NOT IN ('shipment.create', 'shipment.delete', 'shipment.reschedule')
$marker$;
  v_canonical_injection TEXT := $injection$  v_canonical_intent := COALESCE(
    NULLIF(v_target_metadata->>'canonical_intent', ''),
    v_canonical_intent
  );

$injection$;
  v_marker TEXT := $marker$  IF v_canonical_intent NOT IN ('shipment.create', 'shipment.delete', 'shipment.reschedule')
     OR COALESCE(v_target_metadata, '{}'::jsonb) = '{}'::jsonb THEN
    RETURN jsonb_build_object(
      'ok', TRUE,
      'skipped', TRUE,
      'reason', 'non_supported_webhook_mapping_target',
      'mapping_config_id', v_mapping.id,
      'target', v_target
    );
  END IF;
$marker$;
  v_injection TEXT := $injection$
  IF v_canonical_intent = 'shipment.create' THEN
    IF v_source.sender_id IS NULL THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'reason', 'missing_sender_binding',
        'webhook_source_id', v_source.id,
        'mapping_config_id', v_mapping.id
      );
    END IF;

    PERFORM 1
      FROM public.senders s
      JOIN public.clients c ON c.id = s.client_id
     WHERE s.id = v_source.sender_id
       AND c.organization_id = v_source.organization_id
       AND COALESCE(s.status, 'active') = 'active'
       AND COALESCE(c.status, 'active') = 'active';

    IF NOT FOUND THEN
      RETURN jsonb_build_object(
        'ok', FALSE,
        'reason', 'invalid_sender_binding',
        'webhook_source_id', v_source.id,
        'sender_id', v_source.sender_id,
        'mapping_config_id', v_mapping.id
      );
    END IF;
  END IF;
$injection$;
BEGIN
  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.ensure_webhook_source_plugin_binding_v1(uuid) not found';
  END IF;

  IF position('v_canonical_intent := COALESCE' IN v_def) = 0 THEN
    IF position(v_canonical_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected webhook source binding canonical intent marker not found';
    END IF;

    v_def := replace(v_def, v_canonical_marker, v_canonical_injection || v_canonical_marker);
    v_changed := TRUE;
  END IF;

  IF position('missing_sender_binding' IN v_def) = 0 THEN
    IF position(v_marker IN v_def) = 0 THEN
      RAISE EXCEPTION 'expected webhook source binding target marker not found';
    END IF;

    v_def := replace(v_def, v_marker, v_marker || v_injection);
    v_changed := TRUE;
  END IF;

  IF v_changed THEN
    EXECUTE v_def;
  END IF;
END;
$patch$;

DO $assert$
DECLARE
  v_def TEXT;
BEGIN
  SELECT pg_get_functiondef('public.ensure_webhook_source_plugin_binding_v1(uuid)'::regprocedure)
    INTO v_def;

  IF position('missing_sender_binding' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 missing sender/client fail-closed guard';
  END IF;

  IF position('v_canonical_intent := COALESCE' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 missing row-driven canonical intent normalization';
  END IF;

  IF position('v_existing_policy#>>''{ack,response_mapping_id}''' IN COALESCE(v_def, '')) = 0 THEN
    RAISE EXCEPTION 'ensure_webhook_source_plugin_binding_v1 no longer preserves inherited ACK response mapping';
  END IF;
END;
$assert$;

SELECT pg_advisory_unlock(hashtext('202606042100_webhook_source_binding_sender_guard_preserve_v1'));

COMMIT;
