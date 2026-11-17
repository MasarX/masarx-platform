const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const { transform } = require('esbuild');
const ExcelJS = require('exceljs');
const JSZip = require('jszip');

test('resource import executes XLSX prepare with the pinned vendored Workbook', async () => {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet('Hidden', { state: 'hidden' }).addRow(['ignored']);
  const sheet = workbook.addWorksheet('Visible');
  sheet.addRow(['reference', 'quantity', 'note']);
  sheet.addRow(['REF-01', 7, 'قيمة']);
  const bytes = await workbook.xlsx.writeBuffer();
  const organizationId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
  const userId = '22222222-2222-4222-8222-222222222222';
  const rpc = jest.fn(async (name, args) => {
    if (name === 'ui_read_registry_v1') {
      return { data: { resources: [{
        key: 'shipments', import: { enabled: true },
        columns: ['reference', 'quantity', 'note'].map((key) => ({ key, import: { enabled: true } })),
      }] }, error: null };
    }
    if (name === 'ui_resolve_import_scope_context_v1') {
      return { data: { organization_id: organizationId, scope_context: {} }, error: null };
    }
    if (name === 'ui_me_v1') {
      return { data: { org: { id: organizationId }, user: { id: userId } }, error: null };
    }
    if (name === 'ui_tabular_import_profiles_v1') {
      return { data: [], error: null };
    }
    if (name === 'resolve_tabular_import_policy_v1') {
      return { data: [{ value: { max_file_size_bytes: 10485760, max_rows: 5000 } }], error: null };
    }
    if (name === 'register_artifact_v1') {
      return { data: { artifact_id: '33333333-3333-4333-8333-333333333333' }, error: null };
    }
    if (name === 'tabular_import_prepare_v1') {
      return { data: { row_count: args.p_payload.rows.length }, error: null };
    }
    throw new Error(`Unexpected RPC: ${name}`);
  });
  const upload = jest.fn(async () => ({ error: null }));
  const createClient = jest.fn(() => ({ rpc, storage: { from: () => ({ upload }) } }));
  const env = {
    EDGE_SUPABASE_URL: 'https://supabase.example.test',
    EDGE_SUPABASE_ANON_KEY: 'synthetic-anon-key',
    EDGE_SUPABASE_SECRET_KEY: 'synthetic-service-key',
  };
  let handler;
  const context = vm.createContext({
    Request, Response, Headers, FormData, File, Blob, URL, TextEncoder, TextDecoder, ArrayBuffer, Uint8Array,
    setImmediate, clearImmediate, setTimeout, clearTimeout,
    crypto: webcrypto,
    console,
    Deno: { env: { get: (name) => env[name] }, serve: (callback) => { handler = callback; } },
  });
  const entry = path.resolve(__dirname, '../../../supabase/functions/resource-import-studio/index.ts');
  const { code } = await transform(fs.readFileSync(entry, 'utf8'), {
    loader: 'ts', format: 'esm', target: 'es2022',
  });
  const module = new vm.SourceTextModule(code, { context, identifier: entry });
  const excelPath = path.join(path.dirname(entry), '_vendor/exceljs.mjs');
  const excelModule = new vm.SourceTextModule(fs.readFileSync(excelPath, 'utf8'), {
    context, identifier: excelPath,
    initializeImportMeta: (meta) => { meta.url = pathToFileURL(excelPath).href; },
  });
  const builtins = new Map(Object.entries({
    'node:module': { createRequire },
    'node:buffer': { Buffer },
    'node:process': { default: process },
  }).map(([specifier, exports]) => [specifier, new vm.SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  }, { context })]));
  const sdkModule = new vm.SyntheticModule(['createClient'], function () {
    this.setExport('createClient', createClient);
  }, { context });
  const sharedModule = new vm.SourceTextModule(fs.readFileSync(
    path.resolve(__dirname, '../../../supabase/functions/_shared/mod.mjs'), 'utf8',
  ), { context });
  const preparationPath = path.join(path.dirname(entry), 'preparation.ts');
  const preparation = await transform(fs.readFileSync(preparationPath, 'utf8'), {
    loader: 'ts', format: 'esm', target: 'es2022',
  });
  const preparationModule = new vm.SourceTextModule(preparation.code, { context, identifier: preparationPath });
  const limitsPath = path.join(path.dirname(entry), 'upload-limits.ts');
  const limits = await transform(fs.readFileSync(limitsPath, 'utf8'), { loader: 'ts', format: 'esm', target: 'es2022' });
  const limitsModule = new vm.SourceTextModule(limits.code, { context, identifier: limitsPath });
  const zipModule = new vm.SyntheticModule(['default'], function () { this.setExport('default', JSZip); }, { context });
  await module.link((specifier) => {
    if (specifier === './_vendor/exceljs.mjs') return excelModule;
    if (builtins.has(specifier)) return builtins.get(specifier);
    if (specifier === 'npm:jszip@3.10.1') return zipModule;
    if (specifier === './upload-limits.ts') return limitsModule;
    if (specifier === 'npm:@supabase/supabase-js@2.111.0') return sdkModule;
    if (specifier === './_shared/mod.mjs') return sharedModule;
    if (specifier === './preparation.ts') return preparationModule;
    throw new Error(`Unexpected import: ${specifier}`);
  });
  await module.evaluate();

  expect((await handler(new Request('https://app.example.test/import', { method: 'DELETE' }))).status).toBe(405);
  expect((await handler(new Request('https://app.example.test/import', { method: 'POST' }))).status).toBe(401);
  expect(createClient).not.toHaveBeenCalled();

  const form = new FormData();
  form.set('action', 'prepare');
  form.set('resource_key', 'shipments');
  form.set('file', new File([bytes], 'synthetic.xlsx'));
  const response = await handler(new Request('https://app.example.test/import', {
    method: 'POST', headers: { authorization: 'Bearer synthetic-user-token' }, body: form,
  }));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ ok: true, dry_run: { row_count: 1 } });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(rpc).toHaveBeenCalledWith('tabular_import_prepare_v1', {
    p_payload: expect.objectContaining({
      sheet_name: 'Visible',
      source_format: 'xlsx',
      headers: ['reference', 'quantity', 'note'],
      rows: [{ reference: 'REF-01', quantity: '7', note: 'قيمة' }],
    }),
  });
});
