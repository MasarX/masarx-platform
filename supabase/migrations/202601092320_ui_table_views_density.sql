SELECT pg_advisory_lock(hashtext('202601092320_ui_table_views_density'));
UPDATE public.schema_registry
SET schema = jsonb_build_object(
  '$schema', 'http://json-schema.org/draft-07/schema#',
  'type', 'object',
  'properties', jsonb_build_object(
    'resources', jsonb_build_object(
      'type', 'object',
      'additionalProperties', jsonb_build_object(
        'type', 'object',
        'properties', jsonb_build_object(
          'default_view_id', jsonb_build_object('type', 'string'),
          'views', jsonb_build_object(
            'type', 'object',
            'additionalProperties', jsonb_build_object(
              'type', 'object',
              'properties', jsonb_build_object(
                'label', jsonb_build_object('type', 'string'),
                'description', jsonb_build_object('type', 'string'),
                'columns', jsonb_build_object(
                  'type', 'object',
                  'properties', jsonb_build_object(
                    'order', jsonb_build_object(
                      'type', 'array',
                      'items', jsonb_build_object('type', 'string')
                    ),
                    'hidden', jsonb_build_object(
                      'type', 'array',
                      'items', jsonb_build_object('type', 'string')
                    )
                  )
                ),
                'density', jsonb_build_object(
                  'anyOf', jsonb_build_array(
                    jsonb_build_object(
                      'type', 'string',
                      'enum', jsonb_build_array('comfortable', 'compact')
                    ),
                    jsonb_build_object('type', 'null')
                  )
                ),
                'filters', jsonb_build_object(
                  'type', jsonb_build_array('object', 'null'),
                  'additionalProperties', true
                ),
                'sort', jsonb_build_object(
                  'type', 'object',
                  'properties', jsonb_build_object(
                    'key', jsonb_build_object('type', 'string'),
                    'direction', jsonb_build_object(
                      'type', 'string',
                      'enum', jsonb_build_array('asc', 'desc')
                    )
                  )
                ),
                'group_by', jsonb_build_object(
                  'anyOf', jsonb_build_array(
                    jsonb_build_object('type', 'string'),
                    jsonb_build_object(
                      'type', 'array',
                      'items', jsonb_build_object('type', 'string')
                    ),
                    jsonb_build_object('type', 'null')
                  )
                ),
                'page_size', jsonb_build_object('type', 'integer', 'minimum', 1)
              ),
              'required', jsonb_build_array('label')
            )
          )
        )
      )
    )
  )
),
updated_at = now()
WHERE category = 'ui_table_views'
  AND version = 1;

SELECT pg_advisory_unlock(hashtext('202601092320_ui_table_views_density'));
