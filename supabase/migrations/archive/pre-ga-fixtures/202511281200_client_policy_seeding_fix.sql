-- Migration: Client workflow policy seeding fix
-- Purpose:
--   - Ensure baseline clients used in policy-seeding tests have deterministic
--     geocoding/comms/callback/3PL policies, in line with docs/tests/SEED_BASELINES.md.
--   - Implemented via settings/settings_versions only (no hard-coded logic in code).

BEGIN;

WITH providers_cte AS (
  SELECT name, id
  FROM providers
  WHERE name IN ('here_geocoding', 'dialog360_whatsapp', 'logestechs_3pl', 'twilio_sms')
),
clients_cte AS (
  SELECT id, slug, organization_id
  FROM clients
  WHERE slug IN ('test-client-1-1', 'test-client-1-2', 'test-client-1-3', 'test-client-2-1')
)
SELECT 1;

-- Helper: upsert a settings_versions + settings row
-- (pattern copied from existing settings migrations)

-- 0) Ensure missing baseline client test-client-1-2 exists under Test Organization Alpha
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  IF EXISTS (SELECT 1 FROM clients WHERE slug = 'test-client-1-2') THEN
    RETURN;
  END IF;

  SELECT id INTO v_org_id
  FROM organizations
  WHERE slug = 'test-org-alpha'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  INSERT INTO clients (organization_id, name, slug, sla_tier, settings_override, status)
  VALUES (
    v_org_id,
    'Test Client 1-2',
    'test-client-1-2',
    'standard',
    '{}'::jsonb,
    'active'
  )
  ON CONFLICT (organization_id, slug) DO NOTHING;
END;
$$;

-- 1) test-client-1-1: full pipeline (geo + comms + callback + 3PL)
DO $$
DECLARE
  v_client_id UUID;
  v_org_id UUID;
  v_here UUID;
  v_dialog UUID;
  v_logestechs UUID;
  v_geocode JSONB;
  v_comms JSONB;
  v_callback JSONB;
  v_delivery JSONB;
  v_version_id UUID;
BEGIN
  SELECT id, organization_id INTO v_client_id, v_org_id
  FROM clients WHERE slug = 'test-client-1-1' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_here FROM providers WHERE name = 'here_geocoding' LIMIT 1;
  SELECT id INTO v_dialog FROM providers WHERE name = 'dialog360_whatsapp' LIMIT 1;
  SELECT id INTO v_logestechs FROM providers WHERE name = 'logestechs_3pl' LIMIT 1;

  -- geocoding enabled
  v_geocode := jsonb_build_object(
    'version', 1,
    'provider_priority', jsonb_build_array('here_geocoding'),
    'metadata', jsonb_build_object(
      'policy_profile', 'cache_first',
      'primary_provider_id', v_here
    )
  );

  -- comms enabled (single WhatsApp channel)
  v_comms := jsonb_build_object(
    'enabled', TRUE,
    'channels', jsonb_build_array(
      jsonb_build_object(
        'provider_id', v_dialog,
        'channel', 'whatsapp'
      )
    )
  );

  -- callback enabled
  v_callback := jsonb_build_object(
    'enabled', TRUE,
    'callback_url', 'https://callbacks.test-client-1-1.local/webhook'
  );

  -- delivery enabled (Logestechs 3PL)
  v_delivery := jsonb_build_object(
    'enabled', TRUE,
    'provider_id', v_logestechs,
    'retry', jsonb_build_object(
      'max_attempts', 3,
      'backoff_seconds', jsonb_build_array(300, 900, 1800)
    )
  );

  -- Upsert geocoding_policy (update current row if present, else insert)
  UPDATE settings_versions
  SET value = v_geocode,
      change_reason = 'baseline client geocoding policy (test-client-1-1)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'geocoding_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline per-client geocoding policy rows for documented test clients; scope_id is looked up dynamically via slug, not hard-coded id */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('geocoding_policy', 'client', v_client_id, 1, v_geocode, 'baseline client geocoding policy (test-client-1-1)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('geocoding_policy', 'client', v_client_id, v_version_id, v_geocode, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- communications_policy
  UPDATE settings_versions
  SET value = v_comms,
      change_reason = 'baseline client communications policy (test-client-1-1)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'communications_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline per-client communications policy rows for documented test clients; scope_id derives from client slug lookup */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('communications_policy', 'client', v_client_id, 1, v_comms, 'baseline client communications policy (test-client-1-1)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('communications_policy', 'client', v_client_id, v_version_id, v_comms, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- provider_callback_policy
  UPDATE settings_versions
  SET value = v_callback,
      change_reason = 'baseline client callback policy (test-client-1-1)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'provider_callback_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline per-client callback policy rows for test clients used in docs/tests; ids resolved dynamically */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('provider_callback_policy', 'client', v_client_id, 1, v_callback, 'baseline client callback policy (test-client-1-1)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('provider_callback_policy', 'client', v_client_id, v_version_id, v_callback, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- delivery_routing_policy
  UPDATE settings_versions
  SET value = v_delivery,
      change_reason = 'baseline client delivery routing policy (test-client-1-1)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'delivery_routing_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline per-client delivery_routing_policy rows for test clients; scope_id comes from clients table */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('delivery_routing_policy', 'client', v_client_id, 1, v_delivery, 'baseline client delivery routing policy (test-client-1-1)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('delivery_routing_policy', 'client', v_client_id, v_version_id, v_delivery, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;
END;
$$;

-- 2) test-client-1-2: comms only
DO $$
DECLARE
  v_client_id UUID;
  v_dialog UUID;
  v_comms JSONB;
  v_version_id UUID;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'test-client-1-2' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_dialog FROM providers WHERE name = 'dialog360_whatsapp' LIMIT 1;

  v_comms := jsonb_build_object(
    'enabled', TRUE,
    'channels', jsonb_build_array(
      jsonb_build_object(
        'provider_id', v_dialog,
        'channel', 'whatsapp'
      )
    )
  );

  UPDATE settings_versions
  SET value = v_comms,
      change_reason = 'baseline client communications policy (test-client-1-2)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'communications_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline communications policy for test-client-1-2; client id is resolved by slug at runtime */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('communications_policy', 'client', v_client_id, 1, v_comms, 'baseline client communications policy (test-client-1-2)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('communications_policy', 'client', v_client_id, v_version_id, v_comms, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;
END;
$$;

-- 3) test-client-1-3: geocoding + callback (no comms, no 3PL)
DO $$
DECLARE
  v_client_id UUID;
  v_here UUID;
  v_geocode JSONB;
  v_callback JSONB;
  v_version_id UUID;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'test-client-1-3' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_here FROM providers WHERE name = 'here_geocoding' LIMIT 1;

  v_geocode := jsonb_build_object(
    'version', 1,
    'provider_priority', jsonb_build_array('here_geocoding'),
    'metadata', jsonb_build_object(
      'policy_profile', 'cache_first',
      'primary_provider_id', v_here
    )
  );

  v_callback := jsonb_build_object(
    'enabled', TRUE,
    'callback_url', 'https://callbacks.test-client-1-3.local/webhook'
  );

  UPDATE settings_versions
  SET value = v_geocode,
      change_reason = 'baseline client geocoding policy (test-client-1-3)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'geocoding_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline geocoding policy for test-client-1-3; client id is loaded dynamically from clients table */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('geocoding_policy', 'client', v_client_id, 1, v_geocode, 'baseline client geocoding policy (test-client-1-3)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('geocoding_policy', 'client', v_client_id, v_version_id, v_geocode, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  UPDATE settings_versions
  SET value = v_callback,
      change_reason = 'baseline client callback policy (test-client-1-3)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'provider_callback_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed baseline callback policy for test-client-1-3; scope_id uses dynamic client id lookup */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('provider_callback_policy', 'client', v_client_id, 1, v_callback, 'baseline client callback policy (test-client-1-3)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('provider_callback_policy', 'client', v_client_id, v_version_id, v_callback, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;
END;
$$;

-- 4) test-client-2-1: explicitly disable geocoding/comms/callback/delivery
DO $$
DECLARE
  v_client_id UUID;
  v_disabled JSONB := jsonb_build_object('enabled', FALSE, 'metadata', jsonb_build_object('policy_profile', 'disabled'));
  v_disabled_simple JSONB := jsonb_build_object('enabled', FALSE);
  v_version_id UUID;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'test-client-2-1' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  -- geocoding_policy disabled
  UPDATE settings_versions
  SET value = v_disabled,
      change_reason = 'disable geocoding for test-client-2-1',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'geocoding_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed disabled geocoding policy for test-client-2-1 to exercise ladder behaviour; client id resolved dynamically */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('geocoding_policy', 'client', v_client_id, 999, v_disabled, 'disable geocoding for test-client-2-1', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('geocoding_policy', 'client', v_client_id, v_version_id, v_disabled, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- communications_policy disabled
  UPDATE settings_versions
  SET value = v_disabled_simple,
      change_reason = 'disable communications for test-client-2-1',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'communications_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed disabled communications policy for test-client-2-1; used in policy tests, no hard-coded client ids */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('communications_policy', 'client', v_client_id, 999, v_disabled_simple, 'disable communications for test-client-2-1', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('communications_policy', 'client', v_client_id, v_version_id, v_disabled_simple, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- provider_callback_policy disabled
  UPDATE settings_versions
  SET value = v_disabled_simple,
      change_reason = 'disable callback for test-client-2-1',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'provider_callback_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed disabled callback policy for test-client-2-1; client id resolved via slug, not inline literal */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('provider_callback_policy', 'client', v_client_id, 999, v_disabled_simple, 'disable callback for test-client-2-1', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('provider_callback_policy', 'client', v_client_id, v_version_id, v_disabled_simple, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;

  -- delivery_routing_policy disabled
  UPDATE settings_versions
  SET value = v_disabled_simple,
      change_reason = 'disable 3PL delivery for test-client-2-1',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'delivery_routing_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: seed disabled delivery_routing_policy for test-client-2-1; deterministic test configuration only */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('delivery_routing_policy', 'client', v_client_id, 999, v_disabled_simple, 'disable 3PL delivery for test-client-2-1', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('delivery_routing_policy', 'client', v_client_id, v_version_id, v_disabled_simple, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;
END;
$$;

COMMIT;
