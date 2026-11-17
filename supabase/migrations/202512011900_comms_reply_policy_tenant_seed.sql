-- Migration: Seed tenant-level comms_reply_policy (Dialog360) for default org
-- Date: 2025-12-01

BEGIN;

DO $$
DECLARE
    v_org UUID;
    v_auth UUID;
    v_settings_id UUID;
    v_version_id UUID;
    v_payload JSONB;
BEGIN
    SELECT id INTO v_org
    FROM organizations
    ORDER BY created_at
    LIMIT 1;

    SELECT pac.id INTO v_auth
      FROM provider_auth_configs pac
      JOIN providers p ON p.id = pac.provider_id
     WHERE p.name = 'dialog360_whatsapp'
     ORDER BY pac.created_at DESC
     LIMIT 1;

    IF v_org IS NULL OR v_auth IS NULL THEN
        RAISE NOTICE 'Skipping tenant comms_reply_policy seed (org/auth missing)';
        RETURN;
    END IF;

    v_payload := jsonb_build_object(
        'auth_config_id', v_auth,
        'dry_run', false,
        'intents', jsonb_build_object(
            'status', jsonb_build_object(
                'keywords', jsonb_build_array('status', 'where', 'delivery', 'arrive'),
                'template', 'Shipment {tracking_number}: status {status}. ETA {eta}.',
                'not_found_template', 'Sorry, no shipment found for {recipient}.'
            ),
            'eta', jsonb_build_object(
                'keywords', jsonb_build_array('eta', 'when', 'arrive'),
                'template', 'ETA for {tracking_number}: {eta}.',
                'not_found_template', 'Sorry, no shipment found for {recipient}.'
            ),
            'fallback', jsonb_build_object(
                'template', 'Thanks for your message. We will get back to you shortly.'
            )
        )
    );

    SELECT id, settings_version_id INTO v_settings_id, v_version_id
      FROM settings
     WHERE category = 'comms_reply_policy'
       AND scope_type = 'tenant'
       AND scope_id = v_org
     LIMIT 1;

    IF v_settings_id IS NULL THEN
        v_settings_id := gen_random_uuid();
        v_version_id := gen_random_uuid();
        INSERT INTO settings_versions (id, category, scope_type, scope_id, version, value, created_at)
        VALUES (v_version_id, 'comms_reply_policy', 'tenant', v_org, 1, v_payload, now());

        INSERT INTO settings (
            id, category, scope_type, scope_id, settings_version_id, cached_value, last_updated
        ) VALUES (
            v_settings_id, 'comms_reply_policy', 'tenant', v_org, v_version_id, v_payload, now()
        );
    ELSE
        UPDATE settings_versions
           SET value = v_payload
         WHERE id = v_version_id;

        UPDATE settings
           SET cached_value = v_payload,
               last_updated = now()
         WHERE id = v_settings_id;
    END IF;
END;
$$;

COMMIT;
