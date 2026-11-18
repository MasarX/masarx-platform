const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts');
const source = fs.readFileSync(filename, 'utf8');
const pdfSpecifier = 'npm:pdf-lib@1.17.1';
const heavy = [
  pdfSpecifier, 'npm:qrcode-generator@1.5.2',
  'npm:@pdf-lib/fontkit@1.1.1', 'npm:bidi-js@1.0.3', 'npm:bwip-js@4.11.2',
];

// Execute the real entrypoint and private construction boundaries with substituted
// external modules. This is isolate-loading proof, not native JWT/PDF/DB proof.
function loadRenderer({ pdfLoad, bidiFailure } = {}) {
  const imports = [];
  const reachedPdf = new Error('fixture reached PDF construction');
  const createPdf = jest.fn(() => { throw reachedPdf; });
  const bidiFactory = jest.fn(() => {
    if (bidiFailure) throw bidiFailure;
    return { getEmbeddingLevels() {}, getReorderedString: value => value };
  });
  const authorize = jest.fn(() => ({ ok: false, status: 401, message: 'Authentication required' }));
  let handler;
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array,
    console, performance, setTimeout, clearTimeout, atob, btoa,
    Deno: { env: { get: () => undefined }, serve: fn => { handler = fn; } },
  });
  const module = { exports: {} };
  // Expose private functions only in the test copy; unchanged production still loads for the red wave.
  const expose = '\nmodule.exports = { ensureRendererDeps: typeof ensureRendererDeps === "undefined" ? undefined : ensureRendererDeps, renderTemplatePdf, buildFallbackPdf, buildBundleDocument };';
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const execute = vm.runInContext('(function(require,module,exports){\n' + compiled + expose + '\n})',
    sandbox, { filename, timeout: 2000 });
  const pdf = {
    PDFDocument: { create: createPdf }, rgb: jest.fn(), degrees: jest.fn(),
    StandardFonts: { Helvetica: 'Helvetica', HelveticaBold: 'HelveticaBold' },
  };
  const mocks = {
    'npm:@supabase/supabase-js@2.111.0': { createClient: jest.fn(() => {
      throw new Error('unexpected database access');
    }) },
    './_shared/mod.mjs': { readEnv: () => '' },
    './auth.mjs': { authorizeLabelRendererRequest: authorize, resolveLabelRendererOperation: () => 'jobs' },
    '../_shared/db-hotpath.ts': { executeHotpathRpc: jest.fn(), hotpathModeEnabled: () => false },
    '../_shared/label-storage-url.ts': require('../../../supabase/functions/_shared/label-storage-url'),
    '../_shared/asset-cache.ts': require('../../../supabase/functions/_shared/asset-cache'),
    [pdfSpecifier]: pdf,
    'npm:qrcode-generator@1.5.2': { default: jest.fn() },
    'npm:@pdf-lib/fontkit@1.1.1': { default: {} },
    'npm:bidi-js@1.0.3': { default: bidiFactory },
  };
  execute(specifier => {
    if (heavy.includes(specifier)) imports.push(specifier);
    if (specifier === './barcode.ts') return require('../../../supabase/functions/label-renderer/barcode');
    if (specifier === 'npm:bwip-js@4.11.2') return { default: require('bwip-js') };
    if (!Object.hasOwn(mocks, specifier)) throw new Error('Unexpected module: ' + specifier);
    if (specifier === pdfSpecifier && pdfLoad) return pdfLoad().then(() => pdf);
    return mocks[specifier];
  }, module, module.exports);
  return { api: module.exports, handler, imports, createPdf, bidiFactory, reachedPdf, authorize };
}

describe('label renderer lazy dependency startup', () => {
  test('module registration, OPTIONS and generic unauthenticated denial do not load renderer dependencies', async () => {
    const renderer = loadRenderer();
    expect(typeof renderer.handler).toBe('function');
    expect(renderer.imports).toEqual([]);
    const preflight = await renderer.handler(new Request('https://fixture.test', { method: 'OPTIONS' }));
    expect(preflight.status).toBe(204);
    expect(renderer.authorize).not.toHaveBeenCalled();
    const denied = await renderer.handler(new Request('https://fixture.test', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    }));
    expect(denied.status).toBe(401);
    expect(renderer.authorize).toHaveBeenCalledTimes(1);
    expect(renderer.imports).toEqual([]);
    expect(renderer.bidiFactory).not.toHaveBeenCalled();
  });

  test('designer preview retains its own authentication denial without dependency loading', async () => {
    const renderer = loadRenderer();
    const denied = await renderer.handler(new Request('https://fixture.test', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ mode: 'designer_preview' }),
    }));
    expect(denied.status).toBe(401);
    expect((await denied.json()).error.code).toBe('auth_required');
    expect(renderer.authorize).not.toHaveBeenCalled();
    expect(renderer.imports).toEqual([]);
  });

  test('concurrent first rendering calls await one shared dependency load and initialize Bidi once', async () => {
    let release;
    const pdfLoad = new Promise(resolve => { release = resolve; });
    const renderer = loadRenderer({ pdfLoad: () => pdfLoad });
    const calls = [
      renderer.api.renderTemplatePdf({}, {}, {}),
      renderer.api.buildFallbackPdf({}, {}),
      renderer.api.buildBundleDocument([], { downloadConcurrency: 1, chunkSize: 1 }),
    ];
    // Attach observers immediately; no detached rejection or timing-based sleep.
    const settled = Promise.allSettled(calls);
    const first = renderer.api.ensureRendererDeps();
    expect(renderer.api.ensureRendererDeps()).toBe(first);
    await Promise.resolve();
    expect(renderer.createPdf).not.toHaveBeenCalled();
    expect(renderer.bidiFactory).not.toHaveBeenCalled();
    release();
    const results = await settled;
    expect(results).toHaveLength(3);
    for (const result of results) {
      expect(result.status).toBe('rejected');
      expect(result.reason).toBe(renderer.reachedPdf);
    }
    expect(renderer.createPdf).toHaveBeenCalledTimes(3);
    expect(renderer.imports.slice().sort()).toEqual(heavy.slice().sort());
    expect(renderer.bidiFactory).toHaveBeenCalledTimes(1);
    await renderer.api.ensureRendererDeps();
    expect(renderer.imports).toHaveLength(heavy.length);
  });

  test.each(['dependency', 'bidi initialization'])('a failed %s load stays failed without partial rendering or implicit retry', async kind => {
    const failure = new Error('fixture dependency unavailable');
    const renderer = loadRenderer(kind === 'dependency'
      ? { pdfLoad: () => Promise.reject(failure) } : { bidiFailure: failure });
    const first = renderer.api.ensureRendererDeps();
    await expect(first).rejects.toBe(failure);
    expect(renderer.api.ensureRendererDeps()).toBe(first);
    await expect(renderer.api.buildFallbackPdf({}, {})).rejects.toBe(failure);
    expect(renderer.createPdf).not.toHaveBeenCalled();
    expect(renderer.imports.slice().sort()).toEqual(heavy.slice().sort());
  });

  test('every actual PDF construction site, including composed printing, directly awaits the shared loader', () => {
    const ast = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
    const creates = [];
    function visit(node) {
      if (ts.isCallExpression(node) && node.expression.getText(ast) === 'PDFDocument.create') {
        let statement = node;
        while (statement && !ts.isVariableStatement(statement)) statement = statement.parent;
        expect(statement).toBeDefined();
        expect(ts.isBlock(statement.parent)).toBe(true);
        const siblings = Array.from(statement.parent.statements);
        const previous = siblings[siblings.indexOf(statement) - 1];
        expect(previous && previous.getText(ast)).toBe('await ensureRendererDeps();');
        creates.push(node);
      }
      ts.forEachChild(node, visit);
    }
    visit(ast);
    expect(creates).toHaveLength(4);
  });
});
