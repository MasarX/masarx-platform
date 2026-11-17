-- Migration: Global Defaults Seed (response/idempotency/error/rate/retry/schedule)
-- Purpose: Seed system-wide defaults as global settings with schema_registry entries where missing
-- Notes: Append-only, idempotent inserts. Uses minimal schema definitions aligned with docs.

BEGIN;

-- 1) Upsert schema_registry entries (minimal contracts)
WITH regs AS (
  SELECT * FROM (VALUES
    ('response_policy', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,
       "properties":{"synchronous_success":{"type":"integer"},"accepted_async":{"type":"integer"},"bad_request":{"type":"integer"}}}'::jsonb,
     '[{"synchronous_success":200,"accepted_async":202,"bad_request":400}]'::jsonb),
    ('error_policy', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true}'::jsonb,
     '[{"invalid_schema":400,"unauthorized":401,"forbidden":403,"duplicate_key":409,"invalid_state":422,"unexpected":500}]'::jsonb),
    ('idempotency_defaults', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,
       "properties":{"body_path":{"type":"string"},"header":{"type":"string"},
         "normalize":{"type":"object","additionalProperties":true,
            "properties":{"trim":{"type":"boolean"},"quote":{"type":"boolean"}}}}}'::jsonb,
     '[{"body_path":"$.event.id","header":"Idempotency-Key","normalize":{"trim":true,"quote":true}}]'::jsonb),
    ('rate_limit_policy', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,
       "properties":{"requests_per_minute":{"type":"integer","minimum":1},"burst":{"type":"integer","minimum":0}}}'::jsonb,
     '[{"requests_per_minute":600,"burst":60}]'::jsonb),
    ('retry_backoff_policy', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,
       "properties":{"attempts":{"type":"array","items":{"type":"integer","minimum":0}},
         "strategy":{"type":"string","enum":["exponential","fixed","linear"]},
         "jitter":{"type":"string","enum":["none","full","equal"]}}}'::jsonb,
     '[{"attempts":[1,3,10],"strategy":"exponential","jitter":"full"}]'::jsonb),
    ('schedule_policy', 1,
     '{"$schema":"http://json-schema.org/draft-07/schema#","type":"object","additionalProperties":true,
       "properties":{"timezone":{"type":"string"},
         "quiet_hours":{"type":"object","additionalProperties":true,
           "properties":{"start":{"type":"string"},"end":{"type":"string"}}}}}'::jsonb,
     '[{"timezone":"UTC","quiet_hours":{"start":"20:00","end":"08:00"}}]'::jsonb)
  ) AS t(category, version, schema_doc, examples)
)
INSERT INTO schema_registry (category, version, schema, description, examples, is_active)
SELECT r.category, r.version, r.schema_doc, concat(r.category, ' schema (global defaults v1)'), r.examples, TRUE
FROM regs r
ON CONFLICT (category, version)
DO UPDATE SET schema = EXCLUDED.schema, description = EXCLUDED.description, examples = EXCLUDED.examples, is_active = TRUE;

-- 2) Insert global default versions (idempotent)
WITH payloads AS (
  SELECT * FROM (VALUES
    ('response_policy', '{"synchronous_success":200,"accepted_async":202,"bad_request":400}'::jsonb),
    ('error_policy', '{"invalid_schema":400,"unauthorized":401,"forbidden":403,"duplicate_key":409,"invalid_state":422,"unexpected":500}'::jsonb),
    ('idempotency_defaults', '{"body_path":"$.event.id","header":"Idempotency-Key","normalize":{"trim":true,"quote":true}}'::jsonb),
    ('rate_limit_policy', '{"requests_per_minute":600,"burst":60}'::jsonb),
    ('retry_backoff_policy', '{"attempts":[1,3,10],"strategy":"exponential","jitter":"full"}'::jsonb),
    ('schedule_policy', '{"timezone":"UTC","quiet_hours":{"start":"20:00","end":"08:00"}}'::jsonb)
  ) AS t(category, body)
), inserted AS (
  INSERT INTO settings_versions (category, scope_type, scope_id, version, value, approved_at)
  SELECT p.category, 'global', NULL::uuid, 1, p.body, now()
  FROM payloads p
  WHERE NOT EXISTS (
    SELECT 1 FROM settings_versions sv
    WHERE sv.category = p.category AND sv.scope_type = 'global' AND sv.scope_id IS NULL
  )
  RETURNING id, category, value
)
INSERT INTO settings (category, scope_type, scope_id, settings_version_id, cached_value, last_updated)
SELECT i.category, 'global', NULL::uuid, i.id, i.value, now()
FROM inserted i
WHERE NOT EXISTS (
  SELECT 1 FROM settings s WHERE s.category = i.category AND s.scope_type = 'global' AND s.scope_id IS NULL
);

COMMIT;

