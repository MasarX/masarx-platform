-- Migration: Configure HERE geocoding provider mock API key for test environment
-- Purpose:
--   Provide a non-secret, clearly-marked mock API key for the here_geocoding
--   provider so that execute_provider_dispatch_v1 can run end-to-end in
--   automated tests without relying on real HERE credentials.
--   This key is not a real credential and should never be used outside
--   controlled QA environments. Real deployments override this via
--   provider_auth_configs seeded from environment variables.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
  v_provider_id uuid;
  v_existing_id uuid;
BEGIN
  SELECT id
  INTO v_provider_id
  FROM providers
  WHERE name = 'here_geocoding'
  LIMIT 1;

  IF v_provider_id IS NULL THEN
    RAISE NOTICE 'here_geocoding provider not found; skipping mock API key seed';
    RETURN;
  END IF;

  SELECT id
  INTO v_existing_id
  FROM provider_auth_configs
  WHERE provider_id = v_provider_id
    AND auth_type = 'api_key'
  ORDER BY created_at DESC
  LIMIT 1;

  IF v_existing_id IS NULL THEN
    INSERT INTO provider_auth_configs (provider_id, auth_type, credentials, expires_at)
    VALUES (
      v_provider_id,
      'api_key',
      jsonb_build_object(
        'api_key',
        'HERE-TEST-ONLY-DO-NOT-USE-IN-PROD'
      ),
      NULL
    );
  ELSE
    UPDATE provider_auth_configs
    SET credentials = jsonb_build_object(
          'api_key',
          'HERE-TEST-ONLY-DO-NOT-USE-IN-PROD'
        ),
        expires_at = NULL
    WHERE id = v_existing_id;
  END IF;
END;
$$;

COMMIT;

