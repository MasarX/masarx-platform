-- Migration: Prod-ready defaults fixup (schema_registry + global settings)
-- Purpose: Repair shared cloud DB drift where older seed migrations were applied
--          without the required schema contracts / global defaults, causing
--          pgTAP `062_prod_ready_defaults` to fail in CI.

BEGIN;

SET search_path TO public, extensions, pg_temp;

-- 1) Ensure schema contracts exist + are active (idempotent)
WITH regs AS (
  SELECT * FROM (VALUES
    (
      'api_caller_policy'::text,
      1,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true,
        "properties":{"version":{"type":"integer","minimum":1},"default_timeout_seconds":{"type":"integer","minimum":1},
          "max_timeout_seconds":{"type":"integer","minimum":1},"max_retries":{"type":"integer","minimum":0},
          "retry_backoff_seconds":{"type":"array","items":{"type":"integer","minimum":0}},
          "max_payload_bytes":{"type":"integer","minimum":1},"allowed_methods":{"type":"array","items":{"type":"string"}},
          "follow_redirects":{"type":"boolean"},"headers_allowlist":{"type":"array","items":{"type":"string"}},
          "circuit_breaker":{"type":"object","additionalProperties":true}}}'::jsonb,
      '[{"version":1,"default_timeout_seconds":30,"max_timeout_seconds":60,"max_retries":3,"retry_backoff_seconds":[1,3,10],"max_payload_bytes":262144,"allowed_methods":["GET","POST","PUT","PATCH","DELETE"],"follow_redirects":false,"headers_allowlist":["content-type","authorization"],"circuit_breaker":{"failures_before_open":5,"cooldown_seconds":30}}]'::jsonb,
      'API caller policy contract (timeouts, retries, limits)'
    ),
    (
      'campaign_policy'::text,
      1,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true,
        "required":["version","enrollment_enabled"],
        "properties":{"version":{"type":"integer","minimum":1},"enrollment_enabled":{"type":"boolean"},
          "campaign_key":{"type":["string","null"]},"max_campaign_days":{"type":"integer","minimum":0},
          "daily_schedules":{"type":"array","items":{"type":"object"}},"stop_conditions":{"type":"object","additionalProperties":true}}}'::jsonb,
      '[{"version":1,"enrollment_enabled":false,"campaign_key":null,"max_campaign_days":0,"daily_schedules":[],"stop_conditions":{"on_intents":[],"on_statuses":[]}}]'::jsonb,
      'Campaign policy contract (safe default disables enrollment)'
    ),
    (
      'domain_event_policy'::text,
      1,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true,
        "properties":{"version":{"type":"integer","minimum":1},"defaults":{"type":"object"},"events":{"type":"object"}}}'::jsonb,
      '[{"version":1,"defaults":{"action":"skip","rate_limit_per_minute":0},"events":{}}]'::jsonb,
      'Domain event dispatch policy (per-event workflow + safety defaults)'
    ),
    (
      'webhook_intake'::text,
      1,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true,
        "properties":{"version":{"type":"integer","minimum":1},"entry_template_id":{"type":["string","null"]},
          "defaults":{"type":"object","additionalProperties":true,
            "properties":{"accepted_async_status":{"type":"integer","minimum":100,"maximum":599},
              "synchronous_success_status":{"type":"integer","minimum":100,"maximum":599},
              "bad_request_status":{"type":"integer","minimum":100,"maximum":599},
              "error_status":{"type":"integer","minimum":100,"maximum":599},
              "poll_attempts":{"type":"integer","minimum":1},
              "poll_interval_ms":{"type":"integer","minimum":1}}}}}'::jsonb,
      '[{"version":1,"entry_template_id":null,"defaults":{"accepted_async_status":202,"synchronous_success_status":200,"bad_request_status":400,"error_status":500,"poll_attempts":5,"poll_interval_ms":50}}]'::jsonb,
      'Webhook intake policy (entry template + ACK defaults)'
    ),
    (
      'renderer_defaults'::text,
      1,
      '{"$schema":"https://json-schema.org/draft/2020-12/schema","type":"object","additionalProperties":true,
        "properties":{"version":{"type":"integer","minimum":1},"fallback_title":{"type":"string"},
          "brand_name":{"type":["string","null"]},"primary_color":{"type":"string"},"template_key":{"type":["string","null"]}}}'::jsonb,
      '[{"version":1,"fallback_title":"MasarX Waybill","brand_name":"MasarX","primary_color":"#2D3F90","template_key":"masarx_waybill_v1"}]'::jsonb,
      'Renderer defaults contract (branding + template fallback)'
    )
  ) AS t(category, version, schema_doc, examples, description)
)
INSERT INTO schema_registry (category, version, schema, description, examples, is_active)
SELECT r.category, r.version, r.schema_doc, r.description, r.examples, TRUE
FROM regs r
ON CONFLICT (category, version)
DO UPDATE
SET schema = EXCLUDED.schema,
    description = EXCLUDED.description,
    examples = EXCLUDED.examples,
    is_active = TRUE;

-- 2) Ensure global settings rows exist with prod-safe values (idempotent patch)
DO $$
DECLARE
  v_scope_hash CONSTANT UUID := '00000000-0000-0000-0000-000000000000'::uuid;
  v_entry_template_id CONSTANT UUID := '77770000-0000-0000-0000-000000770001'::uuid;
  v_category TEXT;
  v_value JSONB;
  v_current JSONB;
  v_patched JSONB;
  v_settings_id UUID;
  v_settings_version_id UUID;
  v_payloads JSONB := jsonb_build_object(
    'api_caller_policy', jsonb_build_object(
      'version', 1,
      'default_timeout_seconds', 30,
      'max_timeout_seconds', 60,
      'max_retries', 3,
      'retry_backoff_seconds', jsonb_build_array(1,3,10),
      'max_payload_bytes', 262144,
      'allowed_methods', jsonb_build_array('GET','POST','PUT','PATCH','DELETE'),
      'follow_redirects', false,
      'headers_allowlist', jsonb_build_array('content-type','authorization'),
      'circuit_breaker', jsonb_build_object('failures_before_open', 5, 'cooldown_seconds', 30)
    ),
    'campaign_policy', jsonb_build_object(
      'version', 1,
      'enrollment_enabled', false,
      'campaign_key', NULL,
      'max_campaign_days', 0,
      'daily_schedules', jsonb_build_array(),
      'stop_conditions', jsonb_build_object('on_intents', jsonb_build_array(), 'on_statuses', jsonb_build_array())
    ),
    'domain_event_policy', jsonb_build_object(
      'version', 1,
      'defaults', jsonb_build_object('action','skip','rate_limit_per_minute', 0),
      'events', jsonb_build_object()
    ),
    'webhook_intake', jsonb_build_object(
      'version', 1,
      'entry_template_id', v_entry_template_id,
      'defaults', jsonb_build_object(
        'accepted_async_status', 202,
        'synchronous_success_status', 200,
        'bad_request_status', 400,
        'error_status', 500,
        'poll_attempts', 5,
        'poll_interval_ms', 50
      )
    ),
    'renderer_defaults', jsonb_build_object(
      'version', 1,
      'fallback_title', 'MasarX Waybill',
      'brand_name', 'MasarX',
      'primary_color', '#2D3F90',
      'template_key', 'masarx_waybill_v1'
    )
  );
BEGIN
  FOR v_category, v_value IN
    SELECT key, value FROM jsonb_each(v_payloads)
  LOOP
    v_settings_id := NULL;
    v_settings_version_id := NULL;
    v_current := NULL;
    v_patched := NULL;

    SELECT id, settings_version_id
    INTO v_settings_id, v_settings_version_id
    FROM settings
    WHERE category = v_category
      AND scope_type = 'global'
      AND scope_hash = v_scope_hash
    LIMIT 1;

    IF v_settings_version_id IS NULL THEN
      SELECT id
      INTO v_settings_version_id
      FROM settings_versions
      WHERE category = v_category
        AND scope_type = 'global'
        AND scope_hash = v_scope_hash
        AND scope_id IS NULL
      ORDER BY approved_at DESC NULLS LAST, effective_from DESC, created_at DESC
      LIMIT 1;
    END IF;

    IF v_settings_version_id IS NULL THEN
      v_settings_version_id := gen_random_uuid();
      v_patched := v_value;
      INSERT INTO settings_versions (
        id,
        category,
        scope_type,
        scope_id,
        scope_hash,
        version,
        value,
        schema_version,
        change_reason,
        approved_at,
        effective_from,
        effective_until
      )
      VALUES (
        v_settings_version_id,
        v_category,
        'global',
        NULL,
        v_scope_hash,
        1,
        v_patched,
        1,
        'Fix missing prod-ready global defaults',
        now(),
        now(),
        NULL
      );
    ELSE
      SELECT value
      INTO v_current
      FROM settings_versions
      WHERE id = v_settings_version_id
        AND scope_hash = v_scope_hash;

      v_current := COALESCE(v_current, '{}'::jsonb);
      v_patched := jsonb_strip_nulls(v_current || v_value);

      IF jsonb_typeof(v_value->'defaults') = 'object' THEN
        v_patched := jsonb_set(
          v_patched,
          '{defaults}',
          COALESCE(v_current->'defaults', '{}'::jsonb) || COALESCE(v_value->'defaults', '{}'::jsonb),
          true
        );
      END IF;

      IF jsonb_typeof(v_value->'circuit_breaker') = 'object' THEN
        v_patched := jsonb_set(
          v_patched,
          '{circuit_breaker}',
          COALESCE(v_current->'circuit_breaker', '{}'::jsonb) || COALESCE(v_value->'circuit_breaker', '{}'::jsonb),
          true
        );
      END IF;

      IF jsonb_typeof(v_value->'stop_conditions') = 'object' THEN
        v_patched := jsonb_set(
          v_patched,
          '{stop_conditions}',
          COALESCE(v_current->'stop_conditions', '{}'::jsonb) || COALESCE(v_value->'stop_conditions', '{}'::jsonb),
          true
        );
      END IF;

      UPDATE settings_versions
      SET value = v_patched,
          schema_version = COALESCE(schema_version, 1),
          change_reason = COALESCE(change_reason, 'Fix missing prod-ready global defaults'),
          approved_at = COALESCE(approved_at, now()),
          effective_from = COALESCE(effective_from, now()),
          effective_until = NULL
      WHERE id = v_settings_version_id
        AND scope_hash = v_scope_hash;
    END IF;

    INSERT INTO settings (
      id,
      category,
      scope_type,
      scope_id,
      scope_hash,
      settings_version_id,
      cached_value,
      last_updated
    )
    VALUES (
      COALESCE(v_settings_id, gen_random_uuid()),
      v_category,
      'global',
      NULL,
      v_scope_hash,
      v_settings_version_id,
      COALESCE(v_patched, v_value),
      now()
    )
    ON CONFLICT ON CONSTRAINT settings_scope_hash_unique DO UPDATE
    SET settings_version_id = EXCLUDED.settings_version_id,
        cached_value = EXCLUDED.cached_value,
        last_updated = EXCLUDED.last_updated;
  END LOOP;
END $$;

COMMIT;
