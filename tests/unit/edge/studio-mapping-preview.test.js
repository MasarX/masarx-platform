const assert = require('node:assert/strict');
let previewRuntimeMapping;
beforeAll(async () => ({ previewRuntimeMapping } = await import('../../../supabase/functions/integration-plugin-studio/studio-mapping-preview.mjs')));
test('canonical RPC receives unchanged ordered fallbacks and transforms; output is not coerced', async () => {
  const source = { alternative: '12' };
  const config = { field_mappings: { amount: ['$.missing', '$.alternative'] }, transforms: { untouched: '$.other' } };
  const result = { amount: '12', nested: { flag: false }, empty: null };
  const client = { rpc: async (name, args) => {
    assert.equal(name, 'integration_studio_preview_mapping_v1');
    assert.equal(args.p_source, source);
    assert.equal(args.p_mapping_config, config);
    return { data: result };
  } };
  assert.equal(await previewRuntimeMapping(client, source, config), result);
  assert.equal(result.amount, '12');
});
test('RPC errors and invalid results fail closed without leaking private error data', async () => {
  for (const response of [{ error: new Error('PRIVATE') }, { data: null }, { data: [] }, { data: 12 }]) {
    await assert.rejects(previewRuntimeMapping({ rpc: async () => response }, {}, {}),
      error => error.status === 503 && error.code === 'studio.preview.unavailable' && !error.message.includes('PRIVATE'));
  }
  await assert.rejects(previewRuntimeMapping({ rpc: async () => { throw new Error('PRIVATE'); } }, {}, {}), /studio.preview.unavailable/);
});
test('empty canonical mapping output is valid and is not replaced with a local guess', async () => {
  const result = {};
  assert.equal(await previewRuntimeMapping({ rpc: async () => ({ data: result }) }, { id: 1 }, {}), result);
});
