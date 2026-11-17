-- Migration: Extend ui_read_registry schema to support reorder config
BEGIN;
SELECT pg_advisory_lock(hashtext('202601191710_ui_read_registry_reorder_schema'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

UPDATE public.schema_registry
SET schema = jsonb_set(
  schema,
  '{properties,resources,items,properties,reorder}',
  '{
    "type":"object",
    "properties":{
      "order_column":{"type":"string"},
      "group_column":{"type":"string"},
      "require_full":{"type":"boolean"},
      "capability":{"type":"string"},
      "post_action":{"type":"string"}
    },
    "required":["order_column"]
  }'::jsonb,
  true
),
    description = 'UI read registry (v1)',
    is_active = true
WHERE category = 'ui_read_registry'
  AND version = 1;

SELECT pg_advisory_unlock(hashtext('202601191710_ui_read_registry_reorder_schema'));
COMMIT;

