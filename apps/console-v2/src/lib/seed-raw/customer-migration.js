export const logistics_migration_sources = [
  {
    id: 'lms_example_legacy',
    organization_id: 'org_customer_migration_example',
    source_key: 'example-legacy-crm',
    display_name: 'Example Legacy CRM',
    plugin_key: 'customer_migration',
    provider_name: 'Example Logistics',
    status: 'active',
    auth_mode: 'api_key',
    redaction_profile: { fields: ['api_key', 'password', 'token'] },
    created_at: '2026-01-01T08:00:00Z',
    updated_at: '2026-01-01T08:00:00Z',
  },
];

export const logistics_migration_profiles = [
  {
    id: 'lmp_example_clients_customers',
    organization_id: 'org_customer_migration_example',
    source_id: 'lms_example_legacy',
    profile_key: 'clients-and-customers',
    display_name: 'Clients and customers',
    target_entity: 'client_customer',
    status: 'active',
    mapping_rules: {
      client: {
        name: '$.client.name',
        slug: '$.client.slug',
        sla_tier: '$.client.sla',
      },
      customers: {
        external_id: '$.customers[*].external_id',
        name: '$.customers[*].name',
        phone_number: '$.customers[*].phone',
        email: '$.customers[*].email',
      },
    },
    validation_rules: {
      required: ['client.name', 'client.slug', 'customers[].name', 'customers[].phone'],
      idempotency: ['organization_id', 'source_id', 'external_batch_id'],
    },
    created_at: '2026-01-01T08:00:00Z',
    updated_at: '2026-01-01T08:00:00Z',
  },
];

export const logistics_migration_requests = [
  {
    id: 'lmr_example_preview',
    organization_id: 'org_customer_migration_example',
    source_id: 'lms_example_legacy',
    profile_id: 'lmp_example_clients_customers',
    request_key: 'example-batch-preview',
    mode: 'dry_run',
    status: 'validated',
    external_batch_id: 'example-batch-preview',
    imported_client_id: null,
    workflow_run_id: null,
    decision_log_id: null,
    redaction_summary: { secret_fields_redacted: 2, payload_sample: 'redacted' },
    validation_summary: { clients: 1, customers: 2, errors: 0, duplicates: 0 },
    result_summary: { preview: true, would_create_clients: 1, would_import_customers: 2 },
    idempotency_key: 'org_customer_migration_example:lms_example_legacy:example-batch-preview',
    error_summary: null,
    created_at: '2026-01-01T08:05:00Z',
    updated_at: '2026-01-01T08:05:00Z',
  },
];

export const logistics_migration_items = [];
