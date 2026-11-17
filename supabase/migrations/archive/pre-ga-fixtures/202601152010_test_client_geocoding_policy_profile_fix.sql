-- Migration: Align test-client-2-1 geocoding policy disabled profile
-- Purpose:
--   - Ensure test-client-2-1 geocoding_policy reflects policy_profile=disabled.
-- Alignment: SIMPLE | SCALABLE | DYNAMIC | SSOT | ZERO HARD CODING.
-- Date: 2026-01-15

BEGIN;

DO $$
DECLARE
  v_client_id UUID;
  v_change_reason TEXT := 'align geocoding_policy disabled profile for test-client-2-1';
BEGIN
  /* objectives:allow TENANT_LITERAL Justification: deterministic test client policy alignment by slug */
  SELECT id INTO v_client_id FROM public.clients WHERE slug = 'test-client-2-1' LIMIT 1;
  IF v_client_id IS NULL THEN
    RETURN;
  END IF;

  UPDATE public.settings_versions
  SET value = jsonb_set(
              jsonb_set(COALESCE(value, '{}'::jsonb), '{enabled}', 'false'::jsonb, true),
              '{metadata,policy_profile}', '"disabled"'::jsonb, true
            ),
      change_reason = v_change_reason,
      approved_at = now(),
      effective_from = now()
  WHERE category = 'geocoding_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id
    AND effective_until IS NULL;

  UPDATE public.settings
  SET cached_value = jsonb_set(
                      jsonb_set(COALESCE(cached_value, '{}'::jsonb), '{enabled}', 'false'::jsonb, true),
                      '{metadata,policy_profile}', '"disabled"'::jsonb, true
                    ),
      last_updated = now()
  WHERE category = 'geocoding_policy'
    AND scope_type = 'client'
    AND scope_id = v_client_id;
END $$;

COMMIT;
