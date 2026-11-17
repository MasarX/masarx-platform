-- Migration: Provider defaults whatsapp send templates
-- Purpose: Make WhatsApp send request spec fully row-driven via provider_defaults.whatsapp config.
-- Date: 2025-12-13

BEGIN;

DO $$
DECLARE
  v_provider RECORD;
  v_settings RECORD;
  v_now TIMESTAMPTZ := now();
  v_new_value JSONB;
  v_patch_whatsapp JSONB;
  v_next_version INT;
  v_new_version_id UUID;
BEGIN
  v_patch_whatsapp := jsonb_build_object(
    'messages_path', '/v1/messages',
    'api_key_header', 'D360-API-KEY',
    'headers_template', jsonb_build_object(
      'content-type', 'application/json'
    ),
    'text_body_template', jsonb_build_object(
      'to', '{{recipient}}',
      'recipient_type', 'individual',
      'type', 'text',
      'messaging_product', '{{messaging_product}}',
      'text', jsonb_build_object(
        'body', '{{message_text}}'
      )
    )
  );

  FOR v_provider IN
    SELECT id
    FROM providers
    WHERE provider_type = 'comms'
      AND COALESCE(metadata->>'channel', '') = 'whatsapp'
    ORDER BY created_at ASC
  LOOP
    SELECT id AS settings_id, cached_value
      INTO v_settings
      FROM settings
     WHERE category = 'provider_defaults'
       AND scope_type = 'resource'
       AND scope_id = v_provider.id
     ORDER BY last_updated DESC NULLS LAST
     LIMIT 1;

    IF v_settings.settings_id IS NULL THEN
      CONTINUE;
    END IF;

    v_new_value := COALESCE(v_settings.cached_value, '{}'::jsonb);

    -- Ensure messaging_product is present (required by WhatsApp send spec).
    IF NULLIF(COALESCE(v_new_value->>'messaging_product', v_new_value->>'messagingProduct'), '') IS NULL THEN
      v_new_value := jsonb_set(v_new_value, '{messaging_product}', to_jsonb('whatsapp'), TRUE);
    END IF;

    -- Deep-merge whatsapp config: existing keys win over baseline defaults.
    v_new_value := v_new_value || jsonb_build_object(
      'whatsapp',
      v_patch_whatsapp || COALESCE(v_new_value->'whatsapp', '{}'::jsonb)
    );

    IF v_new_value = COALESCE(v_settings.cached_value, '{}'::jsonb) THEN
      CONTINUE;
    END IF;

    SELECT COALESCE(MAX(version), 0) + 1
      INTO v_next_version
      FROM settings_versions
     WHERE category = 'provider_defaults'
       AND scope_type = 'resource'
       AND scope_id = v_provider.id;

    UPDATE settings_versions
       SET effective_until = v_now
     WHERE category = 'provider_defaults'
       AND scope_type = 'resource'
       AND scope_id = v_provider.id
       AND effective_until IS NULL;

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
      v_provider.id,
      v_next_version,
      v_new_value,
      1,
      'Seed provider_defaults.whatsapp send templates for worker-driven WhatsApp sends',
      v_now,
      v_now
    )
    RETURNING id INTO v_new_version_id;

    INSERT INTO settings (
      category,
      scope_type,
      scope_id,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'provider_defaults',
      'resource',
      v_provider.id,
      v_new_version_id,
      v_new_value,
      v_now
    )
    ON CONFLICT (category, scope_type, scope_id)
    DO UPDATE SET
      settings_version_id = EXCLUDED.settings_version_id,
      cached_value = EXCLUDED.cached_value,
      last_updated = EXCLUDED.last_updated;
  END LOOP;
END $$;

COMMIT;
