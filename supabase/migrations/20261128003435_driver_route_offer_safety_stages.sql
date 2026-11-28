BEGIN;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
   SET schema = jsonb_set(schema, '{properties,lock_stages}',
     '{"type":"array","minItems":1,"items":{"type":"object","properties":{"key":{"type":"string"},"speed_min_kph":{"type":"number","minimum":0},"speed_max_kph":{"type":["number","null"],"minimum":0},"ui_mode":{"enum":["full","text_only","suppressed"]},"swipes_enabled":{"type":"boolean"},"voice_only":{"type":"boolean"}},"required":["speed_min_kph","speed_max_kph","ui_mode"],"additionalProperties":false}}'::jsonb, TRUE)
 WHERE category = 'driver_safety_policy' AND is_active
   AND jsonb_typeof(schema->'properties') = 'object' AND schema#>'{properties,lock_stages}' IS NULL;

COMMIT;
