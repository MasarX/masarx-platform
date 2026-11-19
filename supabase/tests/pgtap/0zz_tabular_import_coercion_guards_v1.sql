BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(11);

SELECT is(
  (public.tabular_import_coerce_value_v1(
    '" ext-1 "'::jsonb,
    jsonb_build_object(
      'key', 'external_id',
      'label', 'External Id',
      'edit_type', 'text',
      'import', jsonb_build_object('enabled', true)
    ),
    'External Id'
  )->'value')#>>'{}',
  'ext-1',
  'tabular_import_coerce_value_v1 trims surrounding whitespace for text fields'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"zz"'::jsonb,
      jsonb_build_object(
        'key', 'preferred_language',
        'label', 'Preferred Language',
        'edit_type', 'text',
        'import', jsonb_build_object(
          'enabled', true,
          'enum_values', jsonb_build_array('ar', 'en')
        )
      ),
      'Preferred Language'
    )->'diagnostics' @> '[{"code":"enum_value_invalid","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for invalid configured enum values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"abc"'::jsonb,
      jsonb_build_object(
        'key', 'cod_amount',
        'label', 'COD Amount',
        'edit_type', 'number',
        'import', jsonb_build_object('enabled', true)
      ),
      'COD Amount'
    )->'diagnostics' @> '[{"code":"number_parse_failed","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for invalid number values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"2.5"'::jsonb,
      jsonb_build_object(
        'key', 'box_count',
        'label', 'Box Count',
        'edit_type', 'integer',
        'import', jsonb_build_object('enabled', true)
      ),
      'Box Count'
    )->'diagnostics' @> '[{"code":"integer_parse_failed","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for non-whole integer values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"sometimes"'::jsonb,
      jsonb_build_object(
        'key', 'requires_signature',
        'label', 'Requires Signature',
        'edit_type', 'boolean',
        'import', jsonb_build_object('enabled', true)
      ),
      'Requires Signature'
    )->'diagnostics' @> '[{"code":"boolean_parse_failed","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for invalid boolean values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"not-a-date"'::jsonb,
      jsonb_build_object(
        'key', 'promised_delivery_date',
        'label', 'Promised Delivery Date',
        'edit_type', 'date',
        'import', jsonb_build_object('enabled', true)
      ),
      'Promised Delivery Date'
    )->'diagnostics' @> '[{"code":"date_parse_failed","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for invalid date values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '"not-a-datetime"'::jsonb,
      jsonb_build_object(
        'key', 'pickup_at',
        'label', 'Pickup At',
        'edit_type', 'datetime',
        'import', jsonb_build_object('enabled', true)
      ),
      'Pickup At'
    )->'diagnostics' @> '[{"code":"datetime_parse_failed","blocking":true}]'::jsonb,
    false
  ),
  'tabular_import_coerce_value_v1 emits blocking diagnostics for invalid datetime values'
);

SELECT ok(
  COALESCE(
    public.tabular_import_coerce_value_v1(
      '" ext-tag "'::jsonb,
      jsonb_build_object(
        'key', 'tags',
        'label', 'Tags',
        'edit_type', 'array',
        'import', jsonb_build_object('enabled', true)
      ),
      'Tags'
    )->'value' = '["ext-tag"]'::jsonb,
    false
  ),
  'array coercion wraps the trimmed value rather than the raw spaced string'
);

SELECT ok(
  COALESCE(
    public.normalize_ui_read_registry_import_v1(
      jsonb_build_object(
        'resources',
        jsonb_build_array(
          jsonb_build_object(
            'key', 'recipients',
            'label', 'Recipients',
            'relation', 'public.recipients',
            'capability_read', 'recipients.read',
            'capability_write', 'recipients.write',
            'scope_columns', jsonb_build_object('tenant', 'organization_id', 'client', 'client_id'),
            'columns', jsonb_build_array(
              jsonb_build_object(
                'key', 'preferred_language',
                'label', 'Preferred Language',
                'edit_mode', 'inline',
                'edit_type', 'text',
                'render_type', 'text'
              )
            )
          )
        )
      )
    ) #> '{resources,0,columns,0,import,enum_values}' = '["ar","en"]'::jsonb,
    false
  ),
  'normalize_ui_read_registry_import_v1 seeds recipient preferred_language enum guidance'
);

SELECT is(
  (public.tabular_import_coerce_value_v1(
    '"Out for delivery"'::jsonb,
    jsonb_build_object(
      'key', 'status',
      'label', 'Status',
      'edit_type', 'text',
      'import', jsonb_build_object(
        'enabled', true,
        'lookup', jsonb_build_object(
          'category', 'shipment_status',
          'options', jsonb_build_array(
            jsonb_build_object('value', 'pending', 'label', 'Pending'),
            jsonb_build_object('value', 'out_for_delivery', 'label', 'Out for Delivery')
          )
        )
      )
    ),
    'Status'
  )->'value')#>>'{}',
  'out_for_delivery',
  'tabular_import_coerce_value_v1 maps lookup labels to canonical values'
);

SELECT ok(
  COALESCE(
    public.ui_read_registry_enrich_lookup_import_v1(
      jsonb_build_object(
        'resources',
        jsonb_build_array(
          jsonb_build_object(
            'key', 'shipments',
            'label', 'Shipments',
            'relation', 'public.shipments',
            'capability_read', 'shipments.read',
            'capability_write', 'shipments.write',
            'columns', jsonb_build_array(
              jsonb_build_object(
                'key', 'status',
                'label', 'Status',
                'edit_mode', 'inline',
                'edit_type', 'text',
                'render_type', 'text',
                'import', jsonb_build_object('enabled', true)
              )
            )
          )
        )
      )
    ) #> '{resources,0,columns,0,import,lookup,category}' = '"shipment_status"'::jsonb,
    false
  ),
  'ui_read_registry_enrich_lookup_import_v1 attaches live lookup category metadata for shipments.status'
);

SELECT * FROM finish();

ROLLBACK;
