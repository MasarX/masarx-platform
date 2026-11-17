-- Migration: Seed Logestechs provider defaults for 3PL outbound workflow
-- Purpose: Ensure provider_defaults for logestechs_3pl are present in cloud
-- environments so that 3PL workflows have the required configuration without
-- relying on ad-hoc test seeding.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_provider_id UUID;
  v_defaults JSONB;
BEGIN
  SELECT id
  INTO v_provider_id
  FROM providers
  WHERE name = 'logestechs_3pl'
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE NOTICE 'logestechs_3pl provider not found; skipping provider_defaults seed';
    RETURN;
  END IF;

  v_defaults := jsonb_build_object(
    'service_type', 'STANDARD',
    'shipment_type', 'REGULAR',
    'integration_source', 'INTEGRATION',
    'sender_name', 'TEST',
    'business_sender_name', 'TEST',
    'sender_phone', '561372478',
    'receiver_name', 'QA Receiver',
    'receiver_phone', '+12025550123',
    'cod', 0,
    'package_weight', 1,
    'package_template', jsonb_build_object(
      'weight', 1,
      'quantity', 1,
      'width', 10,
      'length', 10,
      'height', 10,
      'packageItemsToDeliverList', NULL
    ),
    'origin_template', jsonb_build_object(
      'addressLine1', 'kl;klحي ',
      'cityId', 230194,
      'villageId', 343332,
      'regionId', 1265
    ),
    'destination_template', jsonb_build_object(
      'addressLine1', 'TEST',
      'cityId', 230194,
      'villageId', 99689,
      'regionId', 1265
    ),
    'package_items', NULL
  );

  INSERT INTO settings_versions (
    category,
    scope_type,
    scope_id,
    version,
    value,
    schema_version,
    change_reason,
    approved_at,
    effective_from
  )
  VALUES (
    'provider_defaults',
    'resource',
    v_provider_id,
    1,
    v_defaults,
    1,
    'Seed Logestechs provider defaults (cloud)',
    now(),
    now()
  )
  ON CONFLICT DO NOTHING;

  INSERT INTO settings (
    category,
    scope_type,
    scope_id,
    scope_hash,
    settings_version_id,
    cached_value,
    last_updated
  )
  SELECT
    'provider_defaults',
    'resource',
    v_provider_id,
    v_provider_id,
    sv.id,
    sv.value,
    now()
  FROM settings_versions sv
  WHERE sv.category = 'provider_defaults'
    AND sv.scope_type = 'resource'
    AND sv.scope_id = v_provider_id
  ORDER BY sv.effective_from DESC
  LIMIT 1
  ON CONFLICT (category, scope_type, scope_hash) DO UPDATE
    SET settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;
END;
$$;

COMMIT;

