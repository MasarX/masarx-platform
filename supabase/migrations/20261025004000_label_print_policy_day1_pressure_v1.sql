-- Add optional load-profile retry controls without rewriting policy history.
BEGIN;
SET LOCAL lock_timeout = '5s';
SELECT pg_advisory_xact_lock(hashtext('20261025004000_label_print_policy_day1_pressure_v1'));

UPDATE public.schema_registry
SET schema = jsonb_set(schema, '{properties,day1_onboarding_pressure}', $schema${
  "type": "object",
  "additionalProperties": false,
  "properties": {
    "label_http_retry_attempts": { "type": "integer", "minimum": 1, "maximum": 10 },
    "label_http_retry_sleep_ms": { "type": "integer", "minimum": 50 },
    "label_http_retry_backoff_ms": { "type": "integer", "minimum": 50 },
    "label_http_retry_backoff_multiplier": { "type": "number", "minimum": 1 },
    "label_http_retry_max_sleep_ms": { "type": "integer", "minimum": 50 },
    "label_http_retry_jitter_ms": { "type": "integer", "minimum": 0 }
  }
}$schema$::jsonb, true),
    updated_at = now()
WHERE category = 'label_print_policy' AND is_active
  AND NOT (schema->'properties' ? 'day1_onboarding_pressure');

COMMIT;
