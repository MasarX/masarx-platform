-- Migration: Webhook HMAC auth config reseed (dynamic)
-- Purpose:
--   Ensure the test HMAC webhook source ("test-hmac-source") has a
--   provider_auth_configs row with signing_secret = 'EXAMPLE_PASSWORD'
--   and that its webhook_ingest_policy references this auth_config_id so that
--   HMAC validation can succeed in workflow_intake_webhook.

DO $$
DECLARE
  v_source_id uuid;
  v_org_id uuid;
  v_provider_id uuid;
  v_auth_id uuid;
BEGIN
  SELECT id, organization_id
  INTO v_source_id, v_org_id
  FROM webhook_sources
  WHERE source_identifier = 'test-hmac-source'
  ORDER BY created_at
  LIMIT 1;

  IF v_source_id IS NULL THEN
    RAISE NOTICE 'test-hmac-source not found; skipping HMAC auth reseed';
    RETURN;
  END IF;

  SELECT id
  INTO v_provider_id
  FROM providers
  WHERE name = 'webhook_hmac_test'
    AND organization_id = v_org_id
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE NOTICE 'webhook_hmac_test provider not found; skipping HMAC auth reseed';
    RETURN;
  END IF;

  INSERT INTO provider_auth_configs (provider_id, auth_type, credentials, expires_at)
  VALUES (
    v_provider_id,
    'api_key',
    jsonb_build_object('signing_secret', 'EXAMPLE_PASSWORD'),
    NULL
  )
  RETURNING id INTO v_auth_id;

  UPDATE settings AS s
  SET cached_value = jsonb_set(
        COALESCE(cached_value, '{}'::jsonb),
        '{validation,hmac,auth_config_id}',
        to_jsonb(v_auth_id::uuid),
        TRUE
      )
  WHERE s.category = 'webhook_ingest_policy'
    AND s.scope_type = 'source'
    AND s.scope_id = v_source_id;
END;
$$;
