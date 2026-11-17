-- Migration: Extend ui_command_registry schema for bulk action metadata
BEGIN;
SELECT pg_advisory_lock(hashtext('202601131330_ui_command_registry_bulk_actions'));
SET search_path TO public, extensions, pg_temp;
SET LOCAL lock_timeout = '30s';

WITH updated_schema AS (
  SELECT jsonb_build_object(
    '$schema', 'http://json-schema.org/draft-07/schema#',
    'type', 'object',
    'properties', jsonb_build_object(
      'commands', jsonb_build_object(
        'type', 'array',
        'items', jsonb_build_object(
          'type', 'object',
          'properties', jsonb_build_object(
            'key', jsonb_build_object('type', 'string'),
            'label', jsonb_build_object('type', 'string'),
            'description', jsonb_build_object('type', 'string'),
            'capability', jsonb_build_object('type', 'string'),
            'schema_category', jsonb_build_object('type', 'string'),
            'workflow_key', jsonb_build_object('type', 'string'),
            'route_targets', jsonb_build_object(
              'type', 'object',
              'additionalProperties', jsonb_build_object(
                'type', 'object',
                'properties', jsonb_build_object(
                  'path', jsonb_build_object('type', 'string'),
                  'params', jsonb_build_object('type', 'object')
                ),
                'required', jsonb_build_array('path')
              )
            ),
            'selection', jsonb_build_object(
              'type', 'object',
              'properties', jsonb_build_object(
                'mode', jsonb_build_object('type', 'string'),
                'min_count', jsonb_build_object('type', 'integer', 'minimum', 0),
                'max_count', jsonb_build_object('type', 'integer', 'minimum', 1),
                'id_param', jsonb_build_object('type', 'string'),
                'ids_param', jsonb_build_object('type', 'string')
              )
            ),
            'execution', jsonb_build_object(
              'type', 'object',
              'properties', jsonb_build_object(
                'type', jsonb_build_object('type', 'string'),
                'rpc', jsonb_build_object('type', 'string'),
                'params', jsonb_build_object('type', 'object'),
                'confirm', jsonb_build_object(
                  'type', 'object',
                  'properties', jsonb_build_object(
                    'title', jsonb_build_object('type', 'string'),
                    'description', jsonb_build_object('type', 'string'),
                    'tone', jsonb_build_object('type', 'string'),
                    'confirm_label', jsonb_build_object('type', 'string'),
                    'cancel_label', jsonb_build_object('type', 'string')
                  )
                )
              )
            )
          ),
          'required', jsonb_build_array('key','label','capability')
        )
      )
    ),
    'required', jsonb_build_array('commands')
  ) AS schema
)
UPDATE public.schema_registry sr
   SET schema = updated_schema.schema,
       updated_at = now()
  FROM updated_schema
 WHERE sr.category = 'ui_command_registry'
   AND sr.version = 1;

SELECT pg_advisory_unlock(hashtext('202601131330_ui_command_registry_bulk_actions'));
COMMIT;
