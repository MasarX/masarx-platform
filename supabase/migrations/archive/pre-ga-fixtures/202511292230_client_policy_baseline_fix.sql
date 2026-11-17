-- Migration: Client policy baseline alignment
-- Purpose: ensure deterministic comms/delivery policies for test clients used in integration suites.

BEGIN;

SET search_path TO public, pg_temp;

DO $$
DECLARE
    v_dialog UUID;
    v_loges UUID;
BEGIN
    SELECT id INTO v_dialog FROM providers WHERE name = 'dialog360_whatsapp' LIMIT 1;
    SELECT id INTO v_loges FROM providers WHERE name = 'logestechs_3pl' LIMIT 1;

    IF v_dialog IS NULL THEN
        RAISE NOTICE 'dialog360_whatsapp provider missing; skipping policy fix.';
    END IF;
    IF v_loges IS NULL THEN
        RAISE NOTICE 'logestechs_3pl provider missing; skipping delivery policy fix.';
    END IF;

    -- Helper to update both settings_versions.value and settings.cached_value
    WITH target_clients AS (
        SELECT id, slug FROM clients WHERE slug IN ('test-client-1-1', 'test-client-1-2')
    )
    UPDATE settings_versions sv
       SET value = jsonb_set(
                    value,
                    '{enabled}',
                    'true'::jsonb,
                    true
                  )
     WHERE id IN (
        SELECT s.settings_version_id
          FROM settings s
          JOIN target_clients tc ON tc.id = s.scope_id
         WHERE s.category = 'communications_policy'
           AND s.scope_type = 'client'
     );

    UPDATE settings s
       SET cached_value = jsonb_set(
                            COALESCE(cached_value, '{}'::jsonb) ||
                              CASE WHEN v_dialog IS NOT NULL THEN
                                jsonb_build_object(
                                  'channels',
                                  jsonb_build_array(
                                    jsonb_build_object(
                                      'provider_id', v_dialog,
                                      'channel', 'whatsapp',
                                      'template', 'shipment_created_notification'
                                    )
                                  )
                                )
                              ELSE '{}'::jsonb END,
                            '{enabled}',
                            'true'::jsonb,
                            true
                          ),
           last_updated = now()
     WHERE s.category = 'communications_policy'
       AND s.scope_type = 'client'
       AND s.scope_id IN (SELECT id FROM clients WHERE slug IN ('test-client-1-1','test-client-1-2'));

    -- Delivery routing: enable for test-client-1-1 only.
    UPDATE settings_versions sv
       SET value = jsonb_set(
                    value,
                    '{enabled}',
                    'true'::jsonb,
                    true
                  )
     WHERE id IN (
        SELECT s.settings_version_id
          FROM settings s
          JOIN clients c ON c.id = s.scope_id
         WHERE s.category = 'delivery_routing_policy'
           AND s.scope_type = 'client'
           AND c.slug = 'test-client-1-1'
     );

    UPDATE settings s
       SET cached_value = jsonb_set(
                            COALESCE(cached_value, '{}'::jsonb) ||
                              CASE WHEN v_loges IS NOT NULL THEN
                                jsonb_build_object('provider_id', v_loges)
                              ELSE '{}'::jsonb END,
                            '{enabled}',
                            'true'::jsonb,
                            true
                          ),
           last_updated = now()
     WHERE s.category = 'delivery_routing_policy'
       AND s.scope_type = 'client'
       AND s.scope_id IN (SELECT id FROM clients WHERE slug = 'test-client-1-1');
END $$;

COMMIT;

