const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const root = path.resolve(__dirname, '../../../supabase/functions');
const organizationId = randomUUID();
const foreignKey = `${randomUUID()}/fixture.pdf`;
const asRecord = value => value && typeof value === 'object' && !Array.isArray(value) ? value : null;
let shared;
let cors;

beforeAll(async () => {
  shared = await import('../../../supabase/functions/_shared/mod.mjs');
  cors = await import('../../../supabase/functions/_shared/cors.mjs');
});

function evaluate(source, bindings) {
  const module = { exports: {} };
  const code = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, console, ...shared, ...bindings });
  return module.exports;
}

function functions(name, names, bindings) {
  const filename = path.join(root, name, 'index.ts');
  const source = ts.createSourceFile(filename, fs.readFileSync(filename, 'utf8'), ts.ScriptTarget.Latest, true);
  const statements = source.statements.filter(statement =>
    ts.isVariableStatement(statement) &&
    statement.declarationList.declarations.some(declaration => names.includes(declaration.name.getText(source)))
  );
  expect(statements).toHaveLength(names.length);
  return evaluate(statements.map(statement => statement.getText(source)).join('\n') +
    '\nmodule.exports = { ' + names.join(', ') + ' };', bindings);
}

function handler(name, rpc, from) {
  let serve;
  const mockEnv = {
    EDGE_SUPABASE_URL: 'https://storage.example.test',
    EDGE_SUPABASE_ANON_KEY: 'anon',
    EDGE_SUPABASE_SERVICE_ROLE_KEY: 'service',
  };
  evaluate(fs.readFileSync(path.join(root, name, 'index.ts'), 'utf8'), {
    URL, Request, Response, Headers,
    Deno: { serve: fn => { serve = fn; } },
    require(specifier) {
      if (specifier === 'npm:@supabase/supabase-js@2.119.0') {
        return { createClient: () => ({ rpc, storage: { from } }) };
      }
      if (specifier.endsWith('/mod.mjs')) return { ...shared, readEnv: key => mockEnv[key] || '' };
      if (specifier.endsWith('/cors.mjs')) return cors;
      if (specifier.endsWith('/raster-images.mjs') || specifier.startsWith('npm:@xmldom/')) return {};
      throw new Error('Unexpected import ' + specifier);
    },
  });
  return serve;
}

test.each(['global/v1/logo.png', 'fonts/fixture.ttf'])('allows shared label asset %s on read only', key => {
  expect(shared.canonicalStorageKey(key, organizationId, { allowShared: true })).toBe(key);
  expect(shared.canonicalStorageKey(key, organizationId, { write: true })).toBeNull();
});

test('decodes a read key once and preserves spaces and the hash', () => {
  const key = organizationId + '/Quarter%201%20%23.pdf';
  expect(shared.canonicalStorageKey(key, organizationId)).toBe(organizationId + '/Quarter 1 #.pdf');
  expect(shared.canonicalStorageKey(key, organizationId, { write: true })).toBeNull();
});

test.each(['signed_url', 'delete'])('designer %s refuses a key outside the authorized organization', async mode => {
  const rpc = () => ({ single: async () => ({
    data: { ok: true, organization_id: organizationId, can_read: true, can_write: true },
    error: null,
  }) });
  const from = jest.fn();
  const serve = handler('label-designer-assets', rpc, from);
  const response = await serve(new Request('https://example.test/assets', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ mode, path: foreignKey }),
  }));
  expect(response.status).toBe(403);
  expect(from).not.toHaveBeenCalled();
});

test('designer upload rejects a generated key with an invalid filename segment', async () => {
  const rpc = () => ({ single: async () => ({
    data: { ok: true, organization_id: organizationId, can_write: true },
    error: null,
  }) });
  const from = jest.fn();
  const serve = handler('label-designer-assets', rpc, from);
  const response = await serve(new Request('https://example.test/assets', {
    method: 'POST',
    headers: { authorization: 'Bearer fixture', 'content-type': 'application/json' },
    body: JSON.stringify({ mode: 'upload', file_name: '.', file_base64: 'Zg==' }),
  }));
  expect(response.status).toBe(400);
  expect((await response.json()).error.code).toBe('invalid_file_name');
  expect(from).not.toHaveBeenCalled();
});

test('designer preview refreshes organization assets and leaves the shared asset cache intact', async () => {
  const fetchAsset = jest.fn(async () => new Uint8Array([1]));
  const { prepareDesignerPreviewSnapshot } = functions('label-renderer', ['prepareDesignerPreviewSnapshot'], {
    asRecord,
    normalizeString: value => typeof value === 'string' ? value.trim() : undefined,
    fetchAsset,
  });
  const ownKey = organizationId + '/designer/logo.png';
  const sharedKey = 'global/v1/logo.png';
  const assets = [foreignKey, ownKey, sharedKey].map((key, index) => ({ name: 'asset-' + index, path: key }));
  const result = await prepareDesignerPreviewSnapshot({ assets }, 'fixture', organizationId);
  expect(result.assetsUnknownRefs).toEqual(['asset-0']);
  expect(fetchAsset.mock.calls).toEqual([[ownKey, true], [sharedKey, false]]);
});

test('stored snapshot refuses an asset key outside the job organization', async () => {
  const fetchAsset = jest.fn();
  const { loadTemplateAssets } = functions('label-renderer', ['registerAssetKeys', 'loadTemplateAssets'], { fetchAsset });
  const missing = [];
  const result = await loadTemplateAssets({ asset_refs: [{ name: 'logo', path: foreignKey }] }, {}, organizationId, missing);
  expect(result.size).toBe(0);
  expect(missing).toEqual(['logo']);
  expect(fetchAsset).not.toHaveBeenCalled();
});

test('policy font lookup refuses a key outside the job organization', async () => {
  const fetchAsset = jest.fn();
  const { renderTemplateBlocksToPage } = functions('label-renderer', ['renderTemplateBlocksToPage'], {
    asRecord, fetchAsset, normalizeString: value => value, hasArabic: () => true,
    shouldRenderBlock: () => true, resolvePathValue: () => 'نص', stringifyValue: value => value,
    selectFont: jest.fn(), sanitizePdfText: value => value, stripNonAscii: () => '',
  });
  const result = await renderTemplateBlocksToPage({
    label_render_policy: { arabic: { enabled: true, font_asset_regular: foreignKey } },
  }, { organization_id: organizationId }, { renderer_config: { blocks: [{ type: 'text' }] } }, {
    pdfDoc: {}, page: {}, fontCache: new Map(), dotPt: 1,
  });
  expect(result.renderedBlocks).toBe(0);
  expect(fetchAsset).not.toHaveBeenCalled();
});

test('bundle rejects an out-of-scope target before both bulk signing and fallback download', async () => {
  const storageCreateSignedUrls = jest.fn();
  const storageDownloadObject = jest.fn();
  const { collectBundleTargets, buildBundleDocument } = functions('label-renderer', [
    'normalizeBundleFilePathCandidate', 'dedupeBundleTargets', 'collectBundleTargets',
    'downloadLabelPdf', 'createSignedUrlsForBundle', 'mapWithConcurrency', 'buildBundleDocument',
  ], {
    LABEL_BUCKET: 'labels', performance, ensureRendererDeps: async () => {},
    callRpcWithPublicFallback: async () => ({ data: [{ label_id: 'fixture', file_url: foreignKey }], error: null }),
    PDFDocument: { create: async () => ({
      embedFont: async () => ({}), addPage: () => ({ drawRectangle() {}, drawText() {} }),
      getPageCount: () => 1, save: async () => new Uint8Array(),
    }) },
    StandardFonts: {}, rgb: jest.fn(), storageCreateSignedUrls, storageDownloadObject,
  });
  const targets = await collectBundleTargets({ organization_id: organizationId, label_ids: ['fixture'] });
  const result = await buildBundleDocument(targets, { downloadConcurrency: 1, chunkSize: 1 });
  expect(result.placeholders).toMatchObject([{ labelId: 'fixture', fileUrl: null }]);
  expect(storageCreateSignedUrls).not.toHaveBeenCalled();
  expect(storageDownloadObject).not.toHaveBeenCalled();
});

test.each([
  ['workflow output', '?workflow_run_id=fixture', 500, {
    ui_get_workflow_run_output_status_v1: { organization_id: organizationId, output_file_path: foreignKey, output_bucket: 'labels' },
  }],
  ['POD asset', '?resource=shipment_pod_asset&id=fixture&shipment_id=shipment', 404, {
    ui_get_shipment_pod_asset_download_v1: [{ storage_key: foreignKey, storage_bucket: 'fieldops-evidence' }],
    ui_get_resource_v1: { organization_id: organizationId },
  }],
])('UI resource download rejects %s outside the authorized organization', async (_label, query, status, results) => {
  const from = jest.fn();
  const serve = handler('ui-resource-download', async name => ({ data: results[name] }), from);
  const response = await serve(new Request('https://example.test/download' + query, {
    headers: { authorization: 'Bearer fixture' },
  }));
  expect(response.status).toBe(status);
  expect(from).not.toHaveBeenCalled();
});

test('import readback refuses to sign a key outside the scoped run organization', async () => {
  const from = jest.fn();
  const { hydrateArtifacts } = functions('resource-import-studio', ['hydrateArtifacts'], {
    asRecord, asString: value => typeof value === 'string' ? value.trim() : '',
  });
  const artifacts = [{ storage_bucket: 'tabular-imports', storage_key: foreignKey }];
  const run = await hydrateArtifacts({ storage: { from } }, { organization_id: organizationId, artifacts });
  expect(run.artifacts).toEqual(artifacts);
  expect(from).not.toHaveBeenCalled();
});
