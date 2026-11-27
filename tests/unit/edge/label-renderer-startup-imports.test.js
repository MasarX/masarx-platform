const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');

const filename = path.resolve(__dirname, '../../../supabase/functions/label-renderer/index.ts');
const source = fs.readFileSync(filename, 'utf8');
const pdfSpecifier = 'npm:pdf-lib@1.17.1';
const heavy = [
  pdfSpecifier, 'npm:qrcode-generator@1.5.2',
  'npm:@pdf-lib/fontkit@1.1.1', 'npm:bidi-js@1.1.0', 'npm:bwip-js@4.11.2',
];
let cors;
let classifyError;
let errorResponse;

beforeAll(async () => {
  cors = await import('../../../supabase/functions/_shared/cors.mjs');
  ({ classifyError } = await import('../../../supabase/functions/_shared/mod.mjs'));
  errorResponse = await import('../../../supabase/functions/label-renderer/error-response.mjs');
});

// Execute the real entrypoint and private construction boundaries with substituted
// external modules. This is isolate-loading proof, not native JWT/PDF/DB proof.
function loadRenderer({ pdfLoad, pdfModule, bidiFailure, env = {}, client, fetch, File, authorized = false, setTimeout: schedule = setTimeout } = {}) {
  const imports = [];
  const reachedPdf = new Error('fixture reached PDF construction');
  const createPdf = jest.fn(() => { throw reachedPdf; });
  const bidiFactory = jest.fn(() => {
    if (bidiFailure) throw bidiFailure;
    return { getEmbeddingLevels() {}, getReorderedString: value => value };
  });
  const authorize = jest.fn(() => authorized ? { ok: true } : { ok: false, status: 401, message: 'Authentication required' });
  const logStructured = jest.fn();
  let handler;
  const sandbox = vm.createContext({
    Request, Response, Headers, URL, TextEncoder, TextDecoder, Uint8Array, Error, crypto, File, fetch,
    console, performance, setTimeout: schedule, clearTimeout, atob, btoa,
    Deno: { env: { get: () => undefined }, serve: fn => { handler = fn; } },
  });
  const module = { exports: {} };
  // Expose private functions only in the test copy; unchanged production still loads for the red wave.
  const expose = '\nmodule.exports = { ensureRendererDeps: typeof ensureRendererDeps === "undefined" ? undefined : ensureRendererDeps, renderTemplatePdf, buildFallbackPdf, buildBundleDocument, handleBundleRequest, handlePrintRequest };';
  const compiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const execute = vm.runInContext('(function(require,module,exports){\n' + compiled + expose + '\n})',
    sandbox, { filename, timeout: 2000 });
  const pdf = pdfModule ?? {
    PDFDocument: { create: createPdf }, rgb: jest.fn(), degrees: jest.fn(),
    StandardFonts: { Helvetica: 'Helvetica', HelveticaBold: 'HelveticaBold' },
  };
  const mocks = {
    'npm:@supabase/supabase-js@2.119.0': { createClient: jest.fn(() => {
      if (client) return client;
      throw new Error('unexpected database access');
    }) },
    './_shared/mod.mjs': { classifyError, logStructured, readEnv: key => env[key] ?? '' },
    './_shared/cors.mjs': cors,
    './error-response.mjs': errorResponse,
    './auth.mjs': { authorizeLabelRendererRequest: authorize, resolveLabelRendererOperation: () => 'jobs',
      verifyLabelRendererToken: async () => ({ ok: authorized }) },
    '../_shared/db-hotpath.ts': { executeHotpathRpc: jest.fn(), hotpathModeEnabled: () => false },
    '../_shared/label-storage-url.ts': require('../../../supabase/functions/_shared/label-storage-url'),
    '../_shared/asset-cache.ts': require('../../../supabase/functions/_shared/asset-cache'),
    [pdfSpecifier]: pdf,
    'npm:qrcode-generator@1.5.2': { default: jest.fn() },
    'npm:@pdf-lib/fontkit@1.1.1': { default: {} },
    'npm:bidi-js@1.1.0': { default: bidiFactory },
  };
  execute(specifier => {
    if (heavy.includes(specifier)) imports.push(specifier);
    if (specifier === './barcode.ts') return require('../../../supabase/functions/label-renderer/barcode');
    if (specifier === 'npm:bwip-js@4.11.2') return { default: require('bwip-js') };
    if (!Object.hasOwn(mocks, specifier)) throw new Error('Unexpected module: ' + specifier);
    if (specifier === pdfSpecifier && pdfLoad) return pdfLoad().then(() => pdf);
    return mocks[specifier];
  }, module, module.exports);
  return { api: module.exports, handler, imports, createPdf, bidiFactory, reachedPdf, authorize, logStructured };
}

describe('label renderer CORS', () => {
  const endpoint = 'https://edge.example.test/functions/v1/label-renderer';
  const allowedOrigin = 'https://designer.example.test';
  const unlistedOrigin = 'https://unlisted.example.test';
  const hostedEnv = { LABEL_RENDERER_CORS_ALLOW_ORIGINS: allowedOrigin };

  test.each([
    [allowedOrigin, allowedOrigin],
    [unlistedOrigin, null],
    [null, null],
  ])('sets ACAO on POST according to Origin %s', async (origin, allowOrigin) => {
    const { handler } = loadRenderer({ env: hostedEnv });
    const headers = new Headers({ 'content-type': 'application/json' });
    if (origin) headers.set('origin', origin);
    const response = await handler(new Request(endpoint, { method: 'POST', headers, body: '{}' }));
    expect(response.status).toBe(401);
    expect(response.headers.get('access-control-allow-origin')).toBe(allowOrigin);
    expect(response.headers.get('vary').split(', ')).toContain('Origin');
  });

  test.each([
    ['listed origin', hostedEnv, allowedOrigin, allowedOrigin],
    ['unlisted origin', hostedEnv, unlistedOrigin, null],
    ['missing allowlist', {}, allowedOrigin, null],
  ])('returns an empty 204 preflight for %s', async (_case, env, origin, allowOrigin) => {
    const { handler } = loadRenderer({ env });
    const allowHeaders = 'authorization, x-client-info, apikey, content-type';
    const response = await handler(new Request(endpoint, {
      method: 'OPTIONS',
      headers: {
        origin,
        'access-control-request-method': 'POST',
        'access-control-request-headers': allowHeaders,
      },
    }));
    expect(response.status).toBe(204);
    expect(await response.text()).toBe('');
    expect(response.headers.get('access-control-allow-origin')).toBe(allowOrigin);
    expect(response.headers.get('access-control-allow-headers')).toBe(allowOrigin ? allowHeaders : null);
    expect(response.headers.get('access-control-allow-methods')).toBe(allowOrigin ? 'POST, OPTIONS' : null);
  });

  test('returns a marked 500 when CORS evaluation and logging throw before dispatch', async () => {
    const { handler, authorize, logStructured } = loadRenderer();
    const request = new Request(endpoint, { method: 'POST' });
    jest.spyOn(request.headers, 'get').mockImplementation(() => {
      throw new ReferenceError('fixture request detail');
    });
    logStructured.mockImplementationOnce(() => { throw new Error('fixture log detail'); });

    const response = await handler(request);
    expect(response.status).toBe(500);
    expect(response.headers.get('x-masarx-renderer-transport')).toBe('1');
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(await response.json()).toEqual({ error: { code: 'renderer_internal', class: 'unknown' } });
    expect(authorize).not.toHaveBeenCalled();
  });

  test('uses local QA origins only on a loopback endpoint', async () => {
    const origin = 'http://localhost:3000';
    const { handler } = loadRenderer({ env: { PUBLIC_INGRESS_LOCAL_CORS_ALLOW_ORIGINS: origin } });
    const init = { method: 'OPTIONS', headers: { origin } };
    const local = await handler(new Request('http://localhost:54321/functions/v1/label-renderer', init));
    const hosted = await handler(new Request(endpoint, init));
    expect(local.headers.get('access-control-allow-origin')).toBe(origin);
    expect(hosted.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('label renderer internal errors', () => {
  const previewEnv = {
    EDGE_SUPABASE_URL: 'https://fixture.test',
    EDGE_SUPABASE_ANON_KEY: 'fixture-anon',
  };

  test.each([
    [null, 'config_missing'],
    [Object.defineProperty({ severity: 'ERROR' }, 'code', {
      get() { throw new Error('fixture classification detail'); },
    }), 'unknown'],
    [new Error('fixture timeout detail'), 'unknown'],
    [{ code: '42501', details: 'fixture detail', hint: null }, '42501'],
    [{ code: '42501\n', details: 'fixture detail', hint: null }, 'unknown'],
    [{ code: 'ABCDE', message: 'fixture detail' }, 'unknown'],
  ])('returns only the safe preview error envelope for %j (%s)', async (failure, expectedClass) => {
    const renderer = loadRenderer({
      env: failure ? previewEnv : {},
      client: { rpc: () => { throw failure; } },
    });
    const response = await renderer.handler(new Request('https://fixture.test', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'designer_preview', user_jwt: 'fixture-session', draft_id: 'draft', shipment_id: 'shipment',
      }),
    }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: { code: 'renderer_internal', class: expectedClass } });
    expect(renderer.logStructured).toHaveBeenCalledWith('error', 'label_renderer.request_failed', {
      service: 'label-renderer', error_type: expect.any(String),
    });
  });

  test('keeps bundle artifact failures on the fixed upload error contract', async () => {
    const fileFailure = new Error('fixture artifact detail');
    const File = jest.fn(() => { throw fileFailure; });
    const pdf = require('pdf-lib');
    const renderer = loadRenderer({
      pdfModule: {
        ...pdf,
        PDFDocument: {
          async create() {
            const doc = await pdf.PDFDocument.create();
            const addPage = doc.addPage.bind(doc);
            // pdf-lib validates page-size arrays against its own realm.
            doc.addPage = page => addPage(Array.isArray(page) ? Array.from(page) : page);
            return doc;
          },
        },
      },
      env: { ...previewEnv, LABEL_RENDERER_DB_JWT: 'fixture-db-jwt' },
      client: {
        rpc: jest.fn(name => ({
          data: name === 'resolve_label_files_for_bundle' ? [{ label_id: 'label' }] : null,
          error: null,
        })),
        from: jest.fn(() => ({ insert: async () => ({ error: null }) })),
      },
      fetch: jest.fn().mockResolvedValue(Response.json({})),
      File,
    });
    const response = await renderer.api.handleBundleRequest(
      { organization_id: 'fixture-org', expires_seconds: 60 },
      { kind: 'provider', providerName: 'fixture' },
    );
    expect(File).toHaveBeenCalledTimes(1);
    expect(response).toEqual({
      statusCode: 500,
      body: { status: 'failed', error: 'upload_failed', error_class: 'unknown', reason: 'upload_failed' },
    });
  });
});

describe('label renderer response privacy', () => {
  const upstreamText = 'untrusted upstream diagnostic';
  const dbError = { code: '42501', message: upstreamText, details: upstreamText, hint: null };
  const job = { id: 'job', organization_id: 'org', attempts: 0 };
  const template = { renderer_config: { blocks: [{ type: 'text', fallback: 'Synthetic label' }] } };
  const composed = { job: { ...job, template }, payload: {} };
  const row = { job_id: job.id, composed };
  const integration = { kind: 'provider', providerName: 'fixture' };
  const shipment = { shipment_id: 'shipment' };
  const env = { EDGE_SUPABASE_URL: 'https://fixture.test', EDGE_SUPABASE_ANON_KEY: 'fixture-anon' };
  const success = (data = null) => ({ data, error: null });
  const failure = (error = dbError) => ({ data: null, error });

  function expectSafe(result, status, fields) {
    expect(result.statusCode).toBe(status);
    expect(result.body).toMatchObject(fields);
    expect(JSON.stringify(result.body)).not.toContain(upstreamText);
  }

  function printRenderer({ policy, rpcs = {}, unavailable, uploadFailure, pageFailure } = {}) {
    const settings = {
      default_expires_seconds: 60,
      print_sync_bundle_strategy: 'direct',
      print_sync_bundle_return_mode: 'file_path_only',
      single_file_passthrough_enabled: false,
      print_sync_lease_recovery_max_attempts: 1,
      ...policy,
    };
    const responses = {
      resolve_settings_merged: success(settings),
      request_label_generation_bulk_compact_v1: success({ job_ids: [job.id] }),
      lease_and_compose_label_payloads_compact: success([row]),
      lease_label_jobs_by_ids_compact: success([job]),
      lease_label_jobs_by_ids: success([job]),
      compose_label_payloads: success([row]),
      ...rpcs,
    };
    const renderer = loadRenderer({
      env: { ...env, LABEL_RENDERER_DB_JWT: 'fixture-db-jwt' },
      client: {
        rpc: jest.fn((name, args) => typeof responses[name] === 'function'
          ? responses[name](args) : responses[name] ?? success()),
        from: () => ({ insert: async () => success() }),
      },
      fetch: async (_url, { method }) => unavailable || (uploadFailure && method === 'PUT')
        ? new Response(upstreamText, { status: 502 }) : Response.json({}),
      pdfModule: {
        PDFDocument: {
          create: async () => ({
            addPage: () => {
              if (pageFailure) throw new Error(upstreamText);
              return { drawText() {}, getWidth: () => 288 };
            },
            embedFont: async () => ({ widthOfTextAtSize: () => 15 }),
            save: async () => new Uint8Array([1]),
          }),
        },
        StandardFonts: { Helvetica: 'Helvetica', HelveticaBold: 'HelveticaBold' },
        rgb: () => ({}),
        degrees: () => ({}),
      },
      File: class {},
      setTimeout: resolve => queueMicrotask(resolve),
    });
    return {
      ...renderer,
      print: (input = { shipments: [shipment] }) => renderer.api.handlePrintRequest(
        { organization_id: 'org', ...input }, 'correlation', integration,
      ),
      bundle: () => renderer.api.handleBundleRequest({ organization_id: 'org' }, integration),
    };
  }

  function expectPrintFailure(result, status, step, code, errorClass) {
    const fields = { error: code, error_class: errorClass };
    expectSafe(result, status, {
      ...fields,
      steps: expect.arrayContaining([expect.objectContaining({ step, ...fields })]),
    });
  }

  test.each([
    ['direct', 'request_label_generation_bulk_compact_v1', 'enqueue_label_jobs', 'enqueue_label_jobs_failed', {}],
    ['direct', 'request_label_generation_target_v1', 'enqueue_label_jobs', 'enqueue_label_jobs_failed',
      { targets: [{ target_type: 'shipment', target_id: 'shipment' }] }],
    ['direct', 'lease_label_jobs_by_ids_compact', 'render_label_jobs', 'lease_label_jobs_by_ids_compact_failed', {}],
    ['direct', 'compose_label_payloads', 'render_label_jobs', 'compose_label_payloads_failed', {}],
    ['direct', 'complete_label_jobs', 'bundle_labels', 'complete_label_jobs_failed', {}],
    ['merge', 'lease_label_jobs_by_ids', 'render_label_jobs', 'lease_label_jobs_by_ids_failed', {}],
    ['merge', 'compose_label_payloads', 'render_label_jobs', 'compose_label_payloads_failed', {}],
    ['merge', 'complete_label_jobs', 'render_label_jobs', 'complete_label_jobs_failed', {}],
  ])('%s print classifies %s failure in the response and step', async (strategy, rpc, step, code, input) => {
    const renderer = printRenderer({
      policy: { print_sync_bundle_strategy: strategy, print_sync_compact_enabled: false },
      rpcs: { [rpc]: failure() },
    });
    const result = await renderer.print(Object.keys(input).length ? input : undefined);
    expectPrintFailure(result, 500, step, code, '42501');
  });

  test('classifies storage outage in both direct-print and bundle 503 responses', async () => {
    const renderer = printRenderer({ unavailable: true });
    expectPrintFailure(await renderer.print(), 503, 'render_label_jobs', 'label_bucket_unavailable', 'unknown');
    expectSafe(await renderer.bundle(), 503, {
      status: 'failed', reason: 'label_bucket_unavailable', error: 'label_bucket_unavailable', error_class: 'unknown',
    });
  });

  test('classifies render and bundle upload errors in their 500 response and step', async () => {
    expectPrintFailure(await printRenderer({ pageFailure: true }).print(),
      500, 'render_label_jobs', 'render_failure', 'unknown');
    expectPrintFailure(await printRenderer({ uploadFailure: true }).print(),
      500, 'bundle_labels', 'bundle_upload_failed', 'unknown');
  });

  test('records safe passthrough and compact batch fallbacks in a successful print', async () => {
    const renderer = printRenderer({
      policy: { single_file_passthrough_enabled: true },
      rpcs: {
        lease_and_compose_label_payloads_compact: failure(),
        lease_label_jobs_by_ids: failure(),
      },
    });
    const compact = {
      compact_compose_fallback_reason: 'compact_compose_failed', compact_compose_fallback_reason_class: '42501',
    };
    expectSafe(await renderer.print(), 200, {
      status: 'ok',
      artifact_kind: 'bundle',
      steps: expect.arrayContaining([expect.objectContaining({
        step: 'render_label_jobs',
        calls: [
          expect.objectContaining({
            strategy: 'single_file_passthrough', ...compact,
            fallback_reason: 'single_file_passthrough_failed', fallback_reason_class: '42501',
          }),
          expect.objectContaining(compact),
        ],
      })]),
    });
  });

  test('records a safe compact fallback in a successful single-file print', async () => {
    const renderer = printRenderer({
      policy: { single_file_passthrough_enabled: true },
      rpcs: { lease_and_compose_label_payloads_compact: failure() },
    });
    expectSafe(await renderer.print(), 200, {
      status: 'ok',
      artifact_kind: 'single_file',
      steps: expect.arrayContaining([expect.objectContaining({
        step: 'render_label_jobs',
        calls: [expect.objectContaining({
          compact_compose_fallback_reason: 'compact_compose_failed', compact_compose_fallback_reason_class: '42501',
        })],
      })]),
    });
  });

  test('keeps the classified compact fallback when legacy composition returns no rows', async () => {
    const renderer = printRenderer({
      rpcs: { lease_and_compose_label_payloads_compact: failure(), compose_label_payloads: success([]) },
    });
    expectSafe(await renderer.print(), 500, {
      error: 'compose_label_payloads missing rows',
      steps: expect.arrayContaining([expect.objectContaining({
        compact_compose_fallback_reason: 'compact_compose_failed', compact_compose_fallback_reason_class: '42501',
      })]),
    });
  });

  test.each([
    ['lease_label_jobs_by_ids', 'lease_label_jobs_by_ids_failed'],
    ['get_label_jobs_status', 'get_label_jobs_status_failed'],
    ['lease_label_jobs_by_ids_compact', 'lease_label_jobs_by_ids_compact_failed'],
  ])('classifies lease recovery failure from %s', async (rpc, code) => {
    const retry = jest.fn().mockReturnValueOnce(success([])).mockReturnValue(failure());
    const renderer = printRenderer({
      policy: { print_sync_compact_enabled: false, print_sync_lease_recovery_max_attempts: 2 },
      rpcs: {
        lease_label_jobs_by_ids_compact: success([]),
        lease_label_jobs_by_ids: success([]),
        [rpc]: rpc === 'lease_label_jobs_by_ids_compact' ? retry : failure(),
      },
    });
    expectSafe(await renderer.print(), 500, {
      error: 'lease_label_jobs_by_ids_compact missing rows',
      steps: expect.arrayContaining([expect.objectContaining({
        lease_recovery_status_error: code, lease_recovery_status_error_class: '42501',
      })]),
    });
  });

  test('uses the fixed per-job upload reason in results returned by a later print failure', async () => {
    const lease = jest.fn().mockReturnValueOnce(success([job])).mockReturnValue(failure());
    const renderer = printRenderer({
      policy: { print_sync_bundle_strategy: 'merge', render_max_jobs: 1 },
      rpcs: {
        request_label_generation_bulk_compact_v1: success({ job_ids: [job.id, 'another-job'] }),
        lease_label_jobs_by_ids: lease,
      },
      uploadFailure: true,
    });
    expectSafe(await renderer.print(), 500, {
      error: 'lease_label_jobs_by_ids_failed', error_class: '42501',
      steps: expect.arrayContaining([expect.objectContaining({
        results: [expect.objectContaining({ status: 'failed', reason: 'upload_failed', error_class: 'unknown' })],
      })]),
    });
    expect(lease).toHaveBeenCalledTimes(2);
  });

  test.each([
    ['label_designer_whoami', failure(), 403, 'auth_required', '42501'],
    ['label_designer_whoami', success({ ok: false, error: { message: upstreamText } }), 403, 'auth_required', 'unknown'],
    ['draft', failure(), 404, 'draft_not_found', '42501'],
    ['label_designer_get_sample_payload', failure(), 400, 'payload_missing', '42501'],
    ['label_designer_get_sample_payload', success({ ok: false, error: { message: upstreamText } }), 400, 'payload_missing', 'unknown'],
    ['render', null, 200, 'render_failure', 'unknown'],
  ])('classifies designer preview failure at %s', async (stage, failedResult, status, code, errorClass) => {
    const responses = {
      label_designer_whoami: success({ ok: true, organization_id: 'org' }),
      draft: success({ draft_value: { templates: { shipping: {} } } }),
      label_designer_get_sample_payload: success({ ok: true, payload: {} }),
      [stage]: failedResult,
    };
    const renderer = loadRenderer({
      env,
      client: {
        rpc: name => ({ single: async () => responses[name] ?? failure() }),
        from: () => ({ select: () => ({ eq: () => ({ single: async () => responses.draft }) }) }),
      },
      pdfLoad: () => Promise.reject(new Error(upstreamText)),
    });
    const response = await renderer.handler(new Request(env.EDGE_SUPABASE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mode: 'designer_preview', user_jwt: 'fixture-session', draft_id: 'draft', shipment_id: 'shipment',
      }),
    }));
    const result = { statusCode: response.status, body: await response.json() };
    expectSafe(result, status, { ok: false, error: { code, class: errorClass } });
    if (status === 400 || status === 200) {
      expect(result.body.validation).toEqual({ ok: false, error: { code: 'validation_failed', class: '42501' } });
    }
  });

  test.each([false, true])('classifies per-job compose and render failures in worker responses (batch=%s)', async batch => {
    const rpc = jest.fn(name => {
      switch (name) {
        case 'lease_label_job': return { single: async () => success(job) };
        case 'lease_label_jobs': return success([job, { ...job, id: 'next-job' }]);
        case 'compose_label_payload': return {
          single: async () => batch ? success(composed) : failure(),
        };
        default: return success();
      }
    });
    const renderer = loadRenderer({
      env: { ...env, LABEL_RENDERER_DB_JWT: 'fixture-db-jwt' },
      client: { rpc, from: () => ({ insert: async () => success() }) },
      fetch: async () => Response.json({}),
      authorized: true,
      pdfLoad: () => Promise.reject(new Error(upstreamText)),
    });
    const response = await renderer.handler(new Request(env.EDGE_SUPABASE_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ max_jobs: batch ? 2 : 1 }),
    }));
    const result = { statusCode: response.status, body: await response.json() };
    const resultFields = batch
      ? { status: 'ok', jobs: [
        expect.objectContaining({ status: 'failed', error: 'label_render_failed', error_class: 'unknown' }),
        expect.objectContaining({ status: 'failed', error: 'label_render_failed', error_class: 'unknown' }),
      ] }
      : { status: 'failed', reason: 'compose_label_payload_failed', error_class: '42501' };
    expectSafe(result, 200, resultFields);
    expect(JSON.stringify(rpc.mock.calls)).not.toContain(upstreamText);
  });
});

describe('label renderer lazy dependency startup', () => {
  test('module registration, OPTIONS and generic unauthenticated denial do not load renderer dependencies', async () => {
    const renderer = loadRenderer();
    expect(typeof renderer.handler).toBe('function');
    expect(renderer.imports).toEqual([]);
    expect(renderer.logStructured.mock.calls.filter(([, event]) => event === 'label_renderer.supabase_config_missing'))
      .toEqual([['error', 'label_renderer.supabase_config_missing', { service: 'label-renderer' }]]);
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
