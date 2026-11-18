const { upsertSettings } = require('../../../scripts/utils/settings-upsert');

function fixture() {
  const stored = { version: 1, providers: [{ name: 'synthetic', invoke_secret_ref: {
    type: 'SecretRef', id: '00000000-0000-0000-0000-000000000001',
  } }] };
  const db = { query: jest.fn(async (sql) => {
    if (sql.includes('information_schema.tables')) return { rowCount: 1, rows: [{}] };
    if (sql.includes('FROM public.scope_type_registry')) return { rowCount: 1, rows: [{ scope_type: 'global', entity_table: null }] };
    if (sql.includes('FROM public.schema_registry')) return { rowCount: 1, rows: [{ version: 1, schema: {
      type: 'object', required: ['version'], properties: { version: { type: 'integer' } },
    } }] };
    if (sql.includes('FROM public.settings s')) return { rowCount: 0, rows: [] };
    if (sql.includes('FROM public.upsert_label_provider_settings_v1')) return { rowCount: 1, rows: [{
      settings_version_id: '00000000-0000-0000-0000-000000000002', settings_version_number: 1,
    }] };
    if (sql.includes('SELECT value FROM public.settings_versions')) return { rowCount: 1, rows: [{ value: stored }] };
    throw new Error('Unexpected fixture query');
  }) };
  return { db, stored };
}

test('validated provisioning reaches the service writer and returns only its stored reference', async () => {
  const { db, stored } = fixture();
  const result = await upsertSettings({ db, category: 'label_provider', scopeType: 'global', value: {
    version: 1, providers: [{ name: 'synthetic', invoke_secret: 'synthetic-provisioning-secret' }],
  } });
  expect(result.value).toEqual(stored);
  expect(JSON.stringify(result)).not.toContain('synthetic-provisioning-secret');
  expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM public.upsert_label_provider_settings_v1'))).toBe(true);
  expect(db.query.mock.calls.some(([sql]) => sql.includes('FROM public.upsert_settings_value_v1'))).toBe(false);
});

test('provisioning still rejects invalid schema before attempting a credential write', async () => {
  const { db } = fixture();
  await expect(upsertSettings({ db, category: 'label_provider', scopeType: 'global', value: {
    providers: [{ invoke_secret: 'synthetic-invalid-secret' }],
  } })).rejects.toThrow('Schema validation failed');
  expect(db.query.mock.calls.some(([sql]) => sql.includes('upsert_label_provider_settings_v1'))).toBe(false);
});
