-- Test Suite: Label renderer defaults edge cases (global fallback, tenant overrides, template fallback)

BEGIN;

CREATE EXTENSION IF NOT EXISTS pgtap;

SELECT plan(4);

WITH set_source AS (
  SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true)
),
org_seed AS (
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  SELECT
    gen_random_uuid(),
    'Renderer Global Defaults Org',
    format('renderer-global-%s', substr(gen_random_uuid()::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  FROM set_source
  RETURNING id
),
clear_source AS (
  SELECT set_config('app.organization_onboarding_source', '', true)
  FROM org_seed
),
client_seed AS (
  INSERT INTO clients (organization_id, name, slug)
  SELECT
    org_seed.id,
    'Renderer Global Defaults Client',
    format('renderer-global-client-%s', substr(gen_random_uuid()::text, 1, 8))
  FROM org_seed, clear_source
  RETURNING id, organization_id
),
sender_seed AS (
  INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  SELECT
    client_seed.id,
    'Renderer Global Defaults Sender',
    'Renderer Global Defaults Sender',
    FALSE,
    TRUE,
    'active',
    '{}'::jsonb
  FROM client_seed
  RETURNING id, client_id
)
SELECT is(
  (
    SELECT resolved_scope
    FROM resolve_label_template(org_seed.id, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  'global',
  'resolve_label_template falls back to global scope when no tenant/client context provided'
)
FROM org_seed, sender_seed;

WITH set_source AS (
  SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true)
),
tenant_org AS (
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  SELECT
    gen_random_uuid(),
    'Renderer Tenant Scoped Org',
    format('renderer-tenant-%s', substr(gen_random_uuid()::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  FROM set_source
  RETURNING id
),
clear_source AS (
  SELECT set_config('app.organization_onboarding_source', '', true)
  FROM tenant_org
),
client_seed AS (
  INSERT INTO clients (organization_id, name, slug)
  SELECT
    tenant_org.id,
    'Renderer Tenant Scoped Client',
    format('renderer-tenant-client-%s', substr(gen_random_uuid()::text, 1, 8))
  FROM tenant_org, clear_source
  RETURNING id, organization_id
),
sender_seed AS (
  INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  SELECT
    client_seed.id,
    'Renderer Tenant Scoped Sender',
    'Renderer Tenant Scoped Sender',
    FALSE,
    TRUE,
    'active',
    '{}'::jsonb
  FROM client_seed
  RETURNING id, client_id
),
tenant_version AS (
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
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    tenant_org.id,
    tenant_org.id,
    1,
    jsonb_build_object(
      'templates',
      jsonb_build_object(
        'default',
        jsonb_build_object(
          'template_key', 'tenant_default',
          'version', '1.0.0',
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
          'blocks', '[]'::jsonb,
          'assets', '[]'::jsonb,
          'max_attempts', 3,
          'retry_backoff_seconds', jsonb_build_array(30, 60)
        ),
        'shipping',
        jsonb_build_object(
          'template_key', 'tenant_shipping',
          'version', '1.0.0',
          'page', jsonb_build_object('width_inch', 4, 'height_inch', 6, 'dpi', 203, 'orientation', 'portrait'),
          'blocks', '[]'::jsonb,
          'assets', '[]'::jsonb,
          'max_attempts', 3,
          'retry_backoff_seconds', jsonb_build_array(30, 60)
        )
      )
    ),
    2,
    'pgtap tenant label_design fixture',
    now(),
    now()
  FROM tenant_org, sender_seed
  RETURNING id, scope_id, value
),
tenant_settings AS (
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
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    tenant_version.scope_id,
    tenant_version.scope_id,
    tenant_version.id,
    tenant_version.value,
    now()
  FROM tenant_version
  RETURNING scope_id
)
SELECT is(
  (
    SELECT resolved_scope
    FROM resolve_label_template(tenant_settings.scope_id, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  'tenant',
  'Tenant fixture organization resolves tenant-scoped renderer defaults'
)
FROM tenant_settings;

WITH set_source AS (
  SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true)
),
org_seed AS (
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  SELECT
    gen_random_uuid(),
    'Renderer Fallback Org',
    format('renderer-fallback-%s', substr(gen_random_uuid()::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  FROM set_source
  RETURNING id
),
clear_source AS (
  SELECT set_config('app.organization_onboarding_source', '', true)
  FROM org_seed
),
client_seed AS (
  INSERT INTO clients (organization_id, name, slug)
  SELECT
    org_seed.id,
    'Renderer Fallback Client',
    format('renderer-fallback-client-%s', substr(gen_random_uuid()::text, 1, 8))
  FROM org_seed, clear_source
  RETURNING id, organization_id
),
sender_seed AS (
  INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  SELECT
    client_seed.id,
    'Renderer Fallback Sender',
    'Renderer Fallback Sender',
    FALSE,
    TRUE,
    'active',
    '{}'::jsonb
  FROM client_seed
  RETURNING id, client_id
),
default_template AS (
  SELECT jsonb_build_object(
    'template_key', 'fallback_default',
    'version', '1.0.0',
    'page', jsonb_build_object(
      'width_inch', 4,
      'height_inch', 6,
      'dpi', 203,
      'orientation', 'portrait'
    ),
    'blocks', jsonb_build_array(
      jsonb_build_object(
        'type', 'text',
        'x', 20,
        'y', 40,
        'font', 'Helvetica',
        'font_size', 12,
        'value_path', 'shipment.tracking_number',
        'fallback', 'UNKNOWN'
      )
    ),
    'assets', '[]'::jsonb,
    'max_attempts', 3,
    'retry_backoff_seconds', jsonb_build_array(45, 90)
  ) AS config
),
version_ins AS (
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
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    org_seed.id,
    org_seed.id,
    1,
    jsonb_build_object('templates', jsonb_build_object('default', default_template.config)),
    2,
    'pgtap renderer fallback tenant seed',
    now(),
    now()
  FROM org_seed, default_template, sender_seed
  RETURNING id, scope_id
),
settings_ins AS (
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
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    version_ins.scope_id,
    version_ins.scope_id,
    version_ins.id,
    jsonb_build_object('templates', jsonb_build_object('default', default_template.config)),
    now()
  FROM version_ins, default_template
  RETURNING scope_id
)
SELECT is(
  (
    SELECT resolved_scope
    FROM resolve_label_template(settings_ins.scope_id, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  'tenant',
  'Tenant-level label_design with only default template still resolves tenant scope'
)
FROM settings_ins;

WITH set_source AS (
  SELECT set_config('app.organization_onboarding_source', 'provision_demo_accounts_v1', true)
),
fallback_org AS (
  INSERT INTO organizations (id, name, slug, timezone, locale, billing_status)
  SELECT
    gen_random_uuid(),
    'Renderer Fallback Org B',
    format('renderer-fallback-b-%s', substr(gen_random_uuid()::text, 1, 8)),
    'Asia/Riyadh',
    'en-US',
    'active'
  FROM set_source
  RETURNING id
),
clear_source AS (
  SELECT set_config('app.organization_onboarding_source', '', true)
  FROM fallback_org
),
client_seed AS (
  INSERT INTO clients (organization_id, name, slug)
  SELECT
    fallback_org.id,
    'Renderer Fallback Client B',
    format('renderer-fallback-b-client-%s', substr(gen_random_uuid()::text, 1, 8))
  FROM fallback_org, clear_source
  RETURNING id, organization_id
),
sender_seed AS (
  INSERT INTO senders (client_id, name, brand_name, auto_provisioned, auto_recreate, status, settings_override)
  SELECT
    client_seed.id,
    'Renderer Fallback Sender B',
    'Renderer Fallback Sender B',
    FALSE,
    TRUE,
    'active',
    '{}'::jsonb
  FROM client_seed
  RETURNING id, client_id
),
default_template AS (
  SELECT jsonb_build_object(
    'template_key', 'fallback_default',
    'version', '1.0.0',
    'page', jsonb_build_object(
      'width_inch', 4,
      'height_inch', 6,
      'dpi', 203,
      'orientation', 'portrait'
    ),
    'blocks', jsonb_build_array(
      jsonb_build_object(
        'type', 'text',
        'x', 15,
        'y', 30,
        'font', 'Helvetica',
        'font_size', 12,
        'value_path', 'shipment.tracking_number',
        'fallback', 'UNKNOWN'
      )
    ),
    'assets', '[]'::jsonb,
    'max_attempts', 3,
    'retry_backoff_seconds', jsonb_build_array(30, 60)
  ) AS config
),
version_ins AS (
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
    effective_from
  )
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    fallback_org.id,
    fallback_org.id,
    1,
    jsonb_build_object('templates', jsonb_build_object('default', default_template.config)),
    2,
    'pgtap renderer fallback tenant seed b',
    now(),
    now()
  FROM fallback_org, default_template, sender_seed
  RETURNING id, scope_id
),
settings_ins AS (
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
  SELECT
    gen_random_uuid(),
    'label_design',
    'tenant',
    version_ins.scope_id,
    version_ins.scope_id,
    version_ins.id,
    jsonb_build_object('templates', jsonb_build_object('default', default_template.config)),
    now()
  FROM version_ins, default_template
  RETURNING scope_id
)
SELECT is(
  (
    SELECT template_snapshot ->> 'template_key'
    FROM resolve_label_template(settings_ins.scope_id, NULL::uuid, NULL::uuid, 'shipping')
    LIMIT 1
  ),
  'fallback_default',
  'resolve_label_template falls back to tenant default template when label_type missing'
)
FROM settings_ins;

SELECT finish();

ROLLBACK;
