-- Console V2 webhook shipment.created alias policy repair.
--
-- Operators configure incoming provider events as `shipment.created` in webhook
-- source/rule/mapping screens, while shipment materialization uses the canonical
-- workflow intent `shipment.create`. The source-policy repair path must treat
-- that event alias as shipment-creating instead of skipping it as a non-shipment
-- plugin.

BEGIN;

SELECT pg_advisory_lock(hashtext('202605110815_webhook_shipment_created_alias_policy_v1'));

SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

DO $patch$
DECLARE
  v_def TEXT;
  v_old TEXT := 'WHEN v_target IN (''shipments.create'', ''shipment.create'') THEN ''shipment.create''';
  v_new TEXT := 'WHEN v_target IN (''shipments.create'', ''shipment.create'', ''shipment.created'') THEN ''shipment.create''';
BEGIN
  SELECT pg_get_functiondef('public.repair_integration_plugin_webhook_policy_v1(uuid,uuid)'::regprocedure)
    INTO v_def;

  IF v_def IS NULL THEN
    RAISE EXCEPTION 'public.repair_integration_plugin_webhook_policy_v1(uuid,uuid) not found';
  END IF;

  IF position(v_new IN v_def) > 0 THEN
    RETURN;
  END IF;

  IF position(v_old IN v_def) = 0 THEN
    RAISE EXCEPTION 'could not locate shipment-create intent alias case in repair_integration_plugin_webhook_policy_v1';
  END IF;

  v_def := replace(v_def, v_old, v_new);

  IF position(v_new IN v_def) = 0 THEN
    RAISE EXCEPTION 'failed to patch shipment.created alias in repair_integration_plugin_webhook_policy_v1';
  END IF;

  EXECUTE v_def;
END;
$patch$;

COMMENT ON FUNCTION public.repair_integration_plugin_webhook_policy_v1(UUID, UUID)
  IS 'Repairs source-level webhook_ingest_policy from plugin binding while preserving explicit source HMAC validation settings; normalizes shipment.created/shipments.create aliases to canonical shipment.create.';

SELECT pg_advisory_unlock(hashtext('202605110815_webhook_shipment_created_alias_policy_v1'));

COMMIT;
