-- Plan: PLAN-202512-prod-ready-hardening / Step: S04
-- Migration: Ensure client_webhook_policy schema + global default are present
-- Purpose:
--   - Fix pgTAP fixture expectations for client_webhook_policy (schema_registry + global settings row).
--   - Keep behavior row-driven via resolve_settings ladder (no hardcoding).
-- Notes:
--   - Append-only: do not edit historical migrations; this is a forward fix.
-- Date: 2025-12-30

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- ---------------------------------------------------------------------------
-- 0) Ensure category is registered (FK safety)
-- ---------------------------------------------------------------------------
INSERT INTO public.settings_category_registry (category)
VALUES ('client_webhook_policy')
ON CONFLICT (category) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 1) schema_registry entry for client_webhook_policy
-- ---------------------------------------------------------------------------
INSERT INTO public.schema_registry (
  category,
  version,
  schema,
  description,
  examples,
  is_active
)
VALUES (
  'client_webhook_policy',
  1,
  jsonb_build_object(
    'title', 'Client Webhook Policy',
    'type', 'object',
    'additionalProperties', FALSE,
    'required', jsonb_build_array('version'),
    'properties', jsonb_build_object(
      'version', jsonb_build_object('type', 'integer', 'minimum', 1),
      'enabled', jsonb_build_object('type', 'boolean', 'default', FALSE),
      'url', jsonb_build_object('type', 'string', 'format', 'uri'),
      'method', jsonb_build_object(
        'type', 'string',
        'enum', jsonb_build_array('POST', 'PUT', 'PATCH', 'GET', 'DELETE')
      ),
      'headers', jsonb_build_object(
        'type', 'object',
        'additionalProperties', jsonb_build_object('type', 'string')
      ),
      'auth', jsonb_build_object(
        'oneOf', jsonb_build_array(
          jsonb_build_object('type', 'null'),
          jsonb_build_object(
            'type', 'object',
            'additionalProperties', FALSE,
            'properties', jsonb_build_object(
              'mode', jsonb_build_object(
                'type', 'string',
                'enum', jsonb_build_array(
                  'api_key_header',
                  'basic_auth_header',
                  'bearer_token_header',
                  'api_key_query',
                  'body_fields'
                )
              ),
              'auth_config_id', jsonb_build_object('type', 'string', 'format', 'uuid'),
              'header', jsonb_build_object('type', 'string'),
              'scheme', jsonb_build_object('type', 'string'),
              'credential_key', jsonb_build_object('type', 'string'),
              'username_key', jsonb_build_object('type', 'string'),
              'password_key', jsonb_build_object('type', 'string'),
              'query_param', jsonb_build_object('type', 'string'),
              'fields', jsonb_build_object(
                'type', 'object',
                'additionalProperties', jsonb_build_object('type', 'string')
              )
            )
          )
        )
      ),
      'payload', jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'mode', jsonb_build_object(
            'type', 'string',
            'enum', jsonb_build_array('passthrough_raw', 'passthrough_transformed')
          ),
          'mapping_config_id', jsonb_build_object('type', 'string', 'format', 'uuid')
        )
      ),
      'filter', jsonb_build_object(
        'type', 'object',
        'additionalProperties', FALSE,
        'properties', jsonb_build_object(
          'mode', jsonb_build_object(
            'type', 'string',
            'enum', jsonb_build_array('all', 'none', 'allowlist', 'blocklist')
          ),
          'statuses', jsonb_build_object(
            'type', 'array',
            'items', jsonb_build_object('type', 'string')
          )
        )
      ),
      'notes', jsonb_build_object('type', 'string')
    )
  ),
  'Client webhook forwarding policy resolved via ladder (Global -> Tenant -> Client -> Sender -> Source).',
  jsonb_build_array(
    jsonb_build_object(
      'version', 1,
      'enabled', FALSE,
      'method', 'POST',
      'headers', jsonb_build_object('content-type', 'application/json'),
      'payload', jsonb_build_object('mode', 'passthrough_raw'),
      'filter', jsonb_build_object('mode', 'all', 'statuses', jsonb_build_array())
    ),
    jsonb_build_object(
      'version', 1,
      'enabled', TRUE,
      'url', 'https://client.example.com/webhooks/logestechs',
      'method', 'POST',
      'headers', jsonb_build_object('content-type', 'application/json'),
      'auth', jsonb_build_object(
        'mode', 'bearer_token_header',
        'auth_config_id', '11111111-1111-1111-1111-111111111111',
        'credential_key', 'token'
      ),
      'payload', jsonb_build_object('mode', 'passthrough_raw'),
      'filter', jsonb_build_object(
        'mode', 'allowlist',
        'statuses', jsonb_build_array('delivered', 'delivery_failed')
      )
    )
  ),
  TRUE
)
ON CONFLICT (category, version) DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = EXCLUDED.is_active;

-- ---------------------------------------------------------------------------
-- 2) Seed global default for client_webhook_policy (disabled by default)
-- ---------------------------------------------------------------------------
DO $do$
DECLARE
  v_value JSONB := jsonb_build_object(
    'version', 1,
    'enabled', FALSE,
    'method', 'POST',
    'headers', jsonb_build_object('content-type', 'application/json'),
    'payload', jsonb_build_object('mode', 'passthrough_raw'),
    'filter', jsonb_build_object('mode', 'all', 'statuses', jsonb_build_array())
  );
  v_existing_sv UUID;
  v_sv_id UUID;
  v_existing_settings UUID;
BEGIN
  SELECT id
    INTO v_existing_sv
    FROM public.settings_versions_p0
   WHERE category = 'client_webhook_policy'
     AND scope_type = 'global'
     AND scope_id IS NULL
   ORDER BY effective_from DESC
   LIMIT 1;

  IF v_existing_sv IS NOT NULL THEN
    UPDATE public.settings_versions_p0
       SET value = v_value,
           schema_version = 1,
           change_reason = 'Seed global client_webhook_policy default (fixup)',
           approved_at = now(),
           effective_until = NULL,
           effective_from = now()
     WHERE id = v_existing_sv;
    v_sv_id := v_existing_sv;
  ELSE
    INSERT INTO public.settings_versions_p0 (
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
      'client_webhook_policy',
      'global',
      NULL,
      1,
      v_value,
      1,
      'Seed global client_webhook_policy default (fixup)',
      now(),
      now()
    )
    RETURNING id INTO v_sv_id;
  END IF;

  SELECT id
    INTO v_existing_settings
    FROM public.settings
   WHERE category = 'client_webhook_policy'
     AND scope_type = 'global'
     AND scope_hash = '00000000-0000-0000-0000-000000000000'::uuid
   LIMIT 1;

  IF v_existing_settings IS NOT NULL THEN
    UPDATE public.settings
       SET settings_version_id = v_sv_id,
           cached_value = v_value,
           last_updated = now()
     WHERE id = v_existing_settings;
  ELSE
    INSERT INTO public.settings (
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      'client_webhook_policy',
      'global',
      NULL,
      '00000000-0000-0000-0000-000000000000'::uuid,
      v_sv_id,
      v_value,
      now()
    );
  END IF;
END;
$do$;

COMMIT;
