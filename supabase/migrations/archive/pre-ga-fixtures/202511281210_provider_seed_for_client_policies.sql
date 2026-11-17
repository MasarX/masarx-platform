-- Migration: Provider seed for client policy tests
-- Purpose:
--   - Ensure providers `logestechs_3pl` and `twilio_sms` exist so that
--     client policies can reference them by name.
--   - Update test-client-1-1 delivery_routing_policy to point at logestechs_3pl.

BEGIN;

-- 1) Seed logestechs_3pl provider if missing
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  -- Reuse the same organization as other global providers (geocoding/comms)
  SELECT organization_id
  INTO v_org_id
  FROM providers
  WHERE name = 'here_geocoding'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM providers WHERE name = 'logestechs_3pl') THEN
    INSERT INTO providers (organization_id, name, provider_type, enabled, priority_rank, health_status)
    VALUES (v_org_id, 'logestechs_3pl', '3pl', TRUE, 10, 'healthy');
  END IF;
END;
$$;

-- 2) Seed twilio_sms provider if missing (comms baseline)
DO $$
DECLARE
  v_org_id UUID;
BEGIN
  SELECT organization_id
  INTO v_org_id
  FROM providers
  WHERE name = 'dialog360_whatsapp'
  LIMIT 1;

  IF v_org_id IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM providers WHERE name = 'twilio_sms') THEN
    INSERT INTO providers (organization_id, name, provider_type, enabled, priority_rank, health_status)
    VALUES (v_org_id, 'twilio_sms', 'sms', TRUE, 20, 'healthy');
  END IF;
END;
$$;

-- 3) Update delivery_routing_policy for test-client-1-1 to reference logestechs_3pl
DO $$
DECLARE
  v_client_id UUID;
  v_logestechs UUID;
  v_policy JSONB;
  v_version_id UUID;
BEGIN
  SELECT id INTO v_client_id FROM clients WHERE slug = 'test-client-1-1' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  SELECT id INTO v_logestechs FROM providers WHERE name = 'logestechs_3pl' LIMIT 1;
  IF v_logestechs IS NULL THEN
    RETURN;
  END IF;

  SELECT cached_value INTO v_policy
  FROM settings
  WHERE category = 'delivery_routing_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
  LIMIT 1;

  IF v_policy IS NULL THEN
    RETURN;
  END IF;

  v_policy := jsonb_set(v_policy, '{provider_id}', to_jsonb(v_logestechs), TRUE);

  UPDATE settings_versions
  SET value = v_policy,
      change_reason = 'attach logestechs_3pl to delivery_routing_policy (test-client-1-1)',
      approved_at = now(),
      effective_from = now()
  WHERE category = 'delivery_routing_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL
  RETURNING id INTO v_version_id;

  IF v_version_id IS NULL THEN
    /* objectives:allow TENANT_LITERAL Justification: adjust delivery_routing_policy for test-client-1-1 in tests; client id comes from slug lookup, not inline literal */
    INSERT INTO settings_versions (category, scope_type, scope_id, version, value, change_reason, approved_at, effective_from)
    VALUES ('delivery_routing_policy', 'client', v_client_id, 1, v_policy, 'attach logestechs_3pl to delivery_routing_policy (test-client-1-1)', now(), now())
    RETURNING id INTO v_version_id;
  END IF;

  INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
  VALUES ('delivery_routing_policy', 'client', v_client_id, v_version_id, v_policy, now())
  ON CONFLICT (category, scope_type, scope_id)
  DO UPDATE SET settings_version_id = EXCLUDED.settings_version_id, cached_value = EXCLUDED.cached_value, last_updated = EXCLUDED.last_updated;
END;
$$;

COMMIT;
