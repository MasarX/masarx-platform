-- Migration: Prod-ready system defaults (contracts + seeds)
-- Purpose:
--   * Add schema contracts and hardened global defaults for key categories.
--   * Ensure new tenants/clients have safe, validated fallbacks (zero hardcoding).
-- Categories covered: api_caller_policy, campaign_policy, domain_event_policy, webhook_intake, renderer_defaults.

BEGIN;

SET search_path TO public, pg_temp;

-- 1) Schema contracts (idempotent upserts)
WITH docs AS (
  SELECT * FROM (VALUES
    (
      'api_caller_policy'::text,
      1,
      '{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "api_caller_policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "default_timeout_seconds": { "type": "integer", "minimum": 1 },
          "max_timeout_seconds": { "type": "integer", "minimum": 1 },
          "max_retries": { "type": "integer", "minimum": 0 },
          "retry_backoff_seconds": { "type": "array", "items": { "type": "integer", "minimum": 0 } },
          "max_payload_bytes": { "type": "integer", "minimum": 1 },
          "allowed_methods": { "type": "array", "items": { "type": "string" } },
          "follow_redirects": { "type": "boolean" },
          "headers_allowlist": { "type": "array", "items": { "type": "string" } },
          "circuit_breaker": {
            "type": "object",
            "additionalProperties": true,
            "properties": {
              "failures_before_open": { "type": "integer", "minimum": 1 },
              "cooldown_seconds": { "type": "integer", "minimum": 1 }
            }
          }
        }
      }'::jsonb,
      '[{"version":1,"default_timeout_seconds":30,"max_timeout_seconds":60,"max_retries":3,"retry_backoff_seconds":[1,3,10],"max_payload_bytes":262144,"allowed_methods":["GET","POST","PUT","PATCH","DELETE"],"follow_redirects":false,"headers_allowlist":["content-type","authorization"],"circuit_breaker":{"failures_before_open":5,"cooldown_seconds":30}}]'::jsonb,
      'API caller policy contract (timeouts, retries, limits)'
    ),
    (
      'campaign_policy',
      1,
      '{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "campaign_policy",
        "type": "object",
        "additionalProperties": true,
        "required": ["version", "enrollment_enabled"],
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "enrollment_enabled": { "type": "boolean" },
          "campaign_key": { "type": ["string", "null"] },
          "max_campaign_days": { "type": "integer", "minimum": 0 },
          "daily_schedules": { "type": "array", "items": { "type": "object" } },
          "stop_conditions": { "type": "object" }
        }
      }'::jsonb,
      '[{"version":1,"enrollment_enabled":false,"campaign_key":null,"max_campaign_days":0,"daily_schedules":[],"stop_conditions":{"on_intents":[],"on_statuses":[]}}]'::jsonb,
      'Campaign policy contract (safe default disables enrollment)'
    ),
    (
      'domain_event_policy',
      1,
      '{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "domain_event_policy",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "defaults": { "type": "object" },
          "events": { "type": "object" }
        }
      }'::jsonb,
      '[{"version":1,"defaults":{"action":"skip","rate_limit_per_minute":0},"events":{}}]'::jsonb,
      'Domain event dispatch policy (per-event workflow + safety defaults)'
    ),
    (
      'webhook_intake',
      1,
      '{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "webhook_intake",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "entry_template_id": { "type": ["string", "null"], "format": "uuid" },
          "defaults": {
            "type": "object",
            "additionalProperties": true,
            "required": [
              "accepted_async_status",
              "synchronous_success_status",
              "bad_request_status",
              "error_status",
              "poll_attempts",
              "poll_interval_ms"
            ],
            "properties": {
              "accepted_async_status": { "type": "integer", "minimum": 100, "maximum": 599 },
              "synchronous_success_status": { "type": "integer", "minimum": 100, "maximum": 599 },
              "bad_request_status": { "type": "integer", "minimum": 100, "maximum": 599 },
              "error_status": { "type": "integer", "minimum": 100, "maximum": 599 },
              "poll_attempts": { "type": "integer", "minimum": 1 },
              "poll_interval_ms": { "type": "integer", "minimum": 1 }
            }
          }
        }
      }'::jsonb,
      '[{"version":1,"entry_template_id":null,"defaults":{"accepted_async_status":202,"synchronous_success_status":200,"bad_request_status":400,"error_status":500,"poll_attempts":5,"poll_interval_ms":50}}]'::jsonb,
      'Webhook intake policy (entry template + ACK defaults)'
    ),
    (
      'renderer_defaults',
      1,
      '{
        "$schema": "https://json-schema.org/draft/2020-12/schema",
        "title": "renderer_defaults",
        "type": "object",
        "additionalProperties": true,
        "properties": {
          "version": { "type": "integer", "minimum": 1 },
          "fallback_title": { "type": "string" },
          "brand_name": { "type": ["string", "null"] },
          "primary_color": { "type": "string" },
          "template_key": { "type": ["string", "null"] }
        }
      }'::jsonb,
      '[{"version":1,"fallback_title":"Shipping Label","brand_name":null,"primary_color":"#0D3A74","template_key":"zpl_4x6_default"}]'::jsonb,
      'Renderer defaults contract (branding + template fallback)'
    )
  ) AS t(category, version, schema_doc, examples, description)
)
INSERT INTO schema_registry (category, version, schema, description, examples, is_active)
SELECT d.category, d.version, d.schema_doc, d.description, d.examples, TRUE
FROM docs d
ON CONFLICT (category, version)
DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- 2) Prod-ready global defaults (idempotent seeds)
WITH seeds AS (
  SELECT * FROM (VALUES
    ('api_caller_policy'::text, jsonb_build_object(
      'version', 1,
      'default_timeout_seconds', 30,
      'max_timeout_seconds', 60,
      'max_retries', 3,
      'retry_backoff_seconds', jsonb_build_array(1,3,10),
      'max_payload_bytes', 262144,
      'allowed_methods', jsonb_build_array('GET','POST','PUT','PATCH','DELETE'),
      'follow_redirects', false,
      'headers_allowlist', jsonb_build_array('content-type','authorization'),
      'circuit_breaker', jsonb_build_object(
        'failures_before_open', 5,
        'cooldown_seconds', 30
      )
    )),
    ('campaign_policy', jsonb_build_object(
      'version', 1,
      'enrollment_enabled', false,
      'campaign_key', NULL,
      'max_campaign_days', 0,
      'daily_schedules', jsonb_build_array(),
      'stop_conditions', jsonb_build_object(
        'on_intents', jsonb_build_array(),
        'on_statuses', jsonb_build_array()
      )
    )),
    ('domain_event_policy', jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object(
        'action', 'skip',
        'rate_limit_per_minute', 0
      ),
      'events', jsonb_build_object()
    )),
    ('webhook_intake', jsonb_build_object(
      'version', 1,
      'entry_template_id', NULL,
      'defaults', jsonb_build_object(
        'accepted_async_status', 202,
        'synchronous_success_status', 200,
        'bad_request_status', 400,
        'error_status', 500,
        'poll_attempts', 5,
        'poll_interval_ms', 50
      )
    )),
    ('renderer_defaults', jsonb_build_object(
      'version', 1,
      'fallback_title', 'Shipping Label',
      'brand_name', NULL,
      'primary_color', '#0D3A74',
      'template_key', 'zpl_4x6_default'
    ))
  ) AS t(category, payload)
),
ins_versions AS (
  INSERT INTO settings_versions (category, scope_type, scope_id, version, value, approved_at)
  SELECT s.category, 'global', NULL::uuid, 1, s.payload, now()
  FROM seeds s
  ON CONFLICT DO NOTHING
  RETURNING category, id, value
),
resolved_versions AS (
  SELECT
    s.category,
    COALESCE(iv.id, sv.id) AS settings_version_id,
    COALESCE(iv.value, sv.value) AS value
  FROM seeds s
  LEFT JOIN ins_versions iv ON iv.category = s.category
  LEFT JOIN LATERAL (
    SELECT id, value
    FROM settings_versions
    WHERE category = s.category
      AND scope_type = 'global'
      AND scope_id IS NULL
    ORDER BY approved_at DESC
    LIMIT 1
  ) sv ON TRUE
)
INSERT INTO settings (category, scope_type, scope_id, scope_hash, settings_version_id, cached_value, last_updated)
SELECT r.category, 'global', NULL::uuid, '00000000-0000-0000-0000-000000000000'::uuid, r.settings_version_id, r.value, now()
FROM resolved_versions r
ON CONFLICT (category, scope_type, scope_hash)
DO UPDATE
SET settings_version_id = EXCLUDED.settings_version_id,
    cached_value = EXCLUDED.cached_value,
    last_updated = now();

COMMIT;
