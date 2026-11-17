const fs = require('fs');
const path = require('path');
const vm = require('vm');

test.each(['mapping', 'geocodes'])('owned cleanup preserves lineage across %s failure and retry', async (failure) => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../integration/helpers/geocodingWebhookIntake.js'), 'utf8');
  const sandbox = { module: { exports: {} }, require: (name) => name === 'crypto' ? require(name) : {
    getIntegrationFixtureProfile: () => ({ organizations: { alpha: { slug: 'fixture' } } }),
  }, setTimeout };
  vm.runInNewContext(source + '\nmodule.exports.fixtureOwnership = ownedSourceMappings;', sandbox);
  const { cleanupGeocodingTestFixture, fixtureOwnership } = sandbox.module.exports;
  const identifier = 'geocoding-intake-test-owned-retry';
  const lineage = { id: 'source-id', sender_id: 'sender-id', client_id: 'client-id' };
  fixtureOwnership.set(identifier, { id: 'mapping-id', organizationId: 'org-id',
    key: 'owned-key', source: lineage, removed: false });
  let failOnce = true;
  const calls = [];
  // Source has already been deleted in a previous cleanup step. This is the
  // retry boundary: only the recorded owned mapping and source lineage remain.
  const client = { query: async (sql, params) => {
    calls.push({ sql, params });
    if (sql.includes('FROM webhook_sources ws')) return { rows: [] };
    if ((failure === 'mapping' && sql.includes('DELETE FROM public.mapping_configs')) ||
        (failure === 'geocodes' && sql.includes('DELETE FROM geocodes'))) {
      if (failOnce) { failOnce = false; throw new Error('owned-cleanup-transient'); }
    }
    return { rows: [], rowCount: 1 };
  } };
  await expect(cleanupGeocodingTestFixture(client, identifier)).rejects.toThrow('owned-cleanup-transient');
  expect(fixtureOwnership.has(identifier)).toBe(true);
  await cleanupGeocodingTestFixture(client, identifier);
  expect(fixtureOwnership.has(identifier)).toBe(false);
  expect(calls.filter(c => c.sql.includes('DELETE FROM geocoding_attempts')).every(c =>
    JSON.stringify(c.params) === JSON.stringify(['sender-id','client-id']))).toBe(true);
  expect(calls.some(c => c.sql.includes('DELETE FROM geocodes') && c.params[0] === 'client-id')).toBe(true);
  const mappingCalls = calls.filter(c => c.sql.includes('DELETE FROM public.mapping_configs'));
  expect(mappingCalls).toHaveLength(failure === 'mapping' ? 2 : 1);
  for (const call of mappingCalls) {
    expect(Array.from(call.params)).toEqual(['mapping-id','org-id','owned-key']);
    expect(call.sql).toContain('NOT EXISTS');
  }
});
