import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';
import * as ts from 'typescript';
import { Workbook } from 'exceljs';
import * as JSZip from 'jszip';

type RequestHandler = (request: Request) => Promise<Response>;
type Dependencies = Record<string, unknown>;
type PreparedPayload = {
  rows: Array<Record<string, string>>;
  rules: Array<{ source_column: string; target_field: string; enabled: boolean }>;
};
type RpcArguments = { p_payload?: PreparedPayload };
type ImportSettings = { enabled: boolean; max_file_bytes?: number; max_rows?: number };
type ImportColumn = {
  key: string;
  label?: string;
  import: {
    enabled: boolean;
    aliases?: string[];
    reference?: { resource: string; allow_inline_node: boolean; inline_node_key: string; mapping_prefixes: string[] };
  };
};
type ImportResource = { key: string; import?: ImportSettings; columns: ImportColumn[] };
type ConfirmedRun = {
  id: string;
  resource_key: string;
  status: string;
  rows: unknown[];
  report: { id: string } | null;
  summary?: { cancellation: { reason: string } };
};
type LifecycleState = {
  registry: { resources: ImportResource[] };
  profiles: Array<{ header_fingerprint: string; mapping_config: { field_rules: Array<{ target_field: string }> } }>;
  policy: { max_file_size_bytes?: number; max_rows?: number };
  artifactResult: { artifact_id: string } | null;
  run: ConfirmedRun;
  errors: Record<string, string>;
  trusted: boolean;
  authenticated: boolean;
  matrixDimensions?: { rows: number; columns: number };
};
type SuccessfulResponse = {
  dry_run: { total_rows: number };
  run: ConfirmedRun & { summary: { cancellation: { reason: string } } };
  report: { id: string } | null;
  processing_warning?: string | null;
};
type SyntheticSupabase = { auth: { getSession: () => Promise<{ data: { session: { access_token: string } } }> } };
type UiClientExports = {
  createUiClientFromSupabase: (client: SyntheticSupabase) => {
    resourceImports: { cancel: (input: { runId: string; reason: string }) => Promise<unknown> };
  };
};

const root = path.resolve(__dirname, '../..');
const runId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const orgId = '22222222-2222-4222-8222-222222222222';
const userId = '33333333-3333-4333-8333-333333333333';

// Execute the real portable TS entrypoints offline, with only their I/O boundaries mocked.
function tsLoader(globals: Record<string, unknown>, dependencies: Dependencies) {
  const cache = new Map<string, unknown>();
  function load<T = Record<string, unknown>>(file: string): T {
    const absolute = path.resolve(root, file);
    if (cache.has(absolute)) return cache.get(absolute) as T;
    if (path.extname(absolute) === '.json') {
      const json: unknown = JSON.parse(fs.readFileSync(absolute, 'utf8'));
      cache.set(absolute, json);
      return json as T;
    }
    const loadedModule: { exports: unknown } = { exports: {} };
    cache.set(absolute, loadedModule.exports);
    const source = ts.transpileModule(fs.readFileSync(absolute, 'utf8'), {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
    }).outputText;
    const requireMock = (name: string): unknown => {
      if (Object.hasOwn(dependencies, name)) return dependencies[name];
      if (name.startsWith('.')) {
        let target = path.resolve(path.dirname(absolute), name);
        if (!path.extname(target)) target += '.ts';
        return load(target);
      }
      throw new Error(`Unexpected dependency: ${name}`);
    };
    vm.runInNewContext(source, {
      module: loadedModule, exports: loadedModule.exports, require: requireMock,
      File, Blob, FormData, Request, Response, Headers, URL, Buffer,
      ArrayBuffer, Uint8Array, TextEncoder, TextDecoder, Error, console,
      ...globals,
    }, { filename: absolute });
    return loadedModule.exports as T;
  }
  return load;
}

function harness(kind: string) {
  const events: string[] = [];
  const resource: ImportResource & { import: ImportSettings } = {
    key: 'recipients', import: { enabled: true },
    columns: [{ key: 'external_id', label: 'External ID', import: { enabled: true, aliases: ['Recipient code'] } }],
  };
  const state: LifecycleState = {
    registry: { resources: [resource] }, profiles: [],
    policy: { max_file_size_bytes: 1024 * 1024, max_rows: 5000 },
    artifactResult: { artifact_id: 'artifact' },
    run: { id: runId, resource_key: 'recipients', status: 'completed', rows: [], report: { id: 'report' } },
    errors: {}, trusted: true, authenticated: true,
  };
  const userRpc = jest.fn(async (name: string, args: RpcArguments) => {
    events.push(`user:${name}`);
    if (state.errors[name]) return { data: null, error: { message: state.errors[name] } };
    switch (name) {
      case 'ui_read_registry_v1': return { data: state.registry, error: null };
      case 'ui_resolve_import_scope_context_v1': return { data: { organization_id: orgId, scope_context: { tenant: orgId } }, error: null };
      case 'ui_tabular_import_profiles_v1': return { data: state.profiles, error: null };
      case 'resolve_tabular_import_policy_v1': return { data: [{ value: state.policy }], error: null };
      case 'ui_me_v1': return { data: { user: { id: userId }, org: { id: orgId } }, error: null };
      case 'tabular_import_prepare_v1': return { data: { run_id: runId, total_rows: args.p_payload!.rows.length }, error: null };
      case 'ui_start_tabular_import_run_v1': return { data: { id: runId, status: 'queued' }, error: null };
      case 'ui_get_tabular_import_run_v1':
      case 'ui_cancel_tabular_import_run_v1': return { data: state.run, error: null };
      default: throw new Error(`Unexpected user RPC ${name}`);
    }
  });
  const serviceRpc = jest.fn(async (name: string) => {
    events.push(`service:${name}`);
    if (state.errors[name]) return { data: null, error: { message: state.errors[name] } };
    if (name === 'register_artifact_v1') return { data: state.artifactResult, error: null };
    if (name === 'process_tabular_import_run_v1') return { data: { status: 'processing' }, error: null };
    throw new Error(`Unexpected service RPC ${name}`);
  });
  const upload = jest.fn<Promise<{ error: null }>, [string, Blob, unknown?]>(async () => { events.push('storage:upload'); return { error: null }; });
  const signed = jest.fn(async () => ({ data: { signedUrl: 'https://storage.example.test/file' }, error: null }));
  const userClient = { rpc: userRpc };
  const serviceClient = { rpc: serviceRpc, storage: { from: () => ({ upload, createSignedUrl: signed }) } };
  let edgeHandler: RequestHandler | undefined;
  class TracedWorkbook extends Workbook {
    constructor() {
      super();
      const load = this.xlsx.load.bind(this.xlsx);
      this.xlsx.load = async (...args: Parameters<typeof load>) => {
        events.push('workbook:parse'); const result = await load(...args);
        if (state.matrixDimensions) {
          const sheet = this.worksheets[0]!;
          Object.defineProperty(sheet, 'rowCount', { value: state.matrixDimensions.rows });
          Object.defineProperty(sheet, 'columnCount', { value: state.matrixDimensions.columns });
          sheet.getRow = () => { events.push('matrix:row'); throw new Error('Matrix row must not be allocated'); };
        }
        return result;
      };
    }
  }
  const env: Record<string, string> = { EDGE_SUPABASE_URL: 'https://example.test', EDGE_SUPABASE_ANON_KEY: 'test-anon', EDGE_SUPABASE_SECRET_KEY: 'test-service', SUPABASE_SECRET_KEY: 'test-service' };
  const dependencies: Dependencies = {
    jszip: { default: JSZip }, 'npm:jszip@3.10.2': { default: JSZip },
    'npm:@supabase/supabase-js@2.119.0': { createClient: (_url: string, _key: string, options: { global: { headers: Record<string, string> } }) => options.global.headers.Authorization ? userClient : serviceClient },
    './_vendor/exceljs.mjs': { Workbook: TracedWorkbook },
    './_shared/mod.mjs': {
      readEnv: (key: string, fallbacks: string[] = []) => [key, ...fallbacks].map((entry) => env[entry]).find(Boolean) || '',
      extractToken: () => state.authenticated ? 'synthetic-session' : '',
      resolveCorrelationId: () => 'request-id', resolveTraceContext: () => ({}),
      parseRequestBody: async (request: Request) => ({ json: await request.json() }), logStructured: jest.fn(),
      buildErrorEnvelope: ({ code, message }: { code: string; message: string }) => ({ error: { code, message } }),
    },
    '@supabase/supabase-js': { createClient: () => serviceClient },
    exceljs: { Workbook: TracedWorkbook },
    '@masarx/auth': {
      validateTrustedBrowserRequest: () => state.trusted ? { ok: true } : { ok: false, status: 403, code: 'untrusted', message: 'Untrusted' },
      getVerifiedAccessToken: async () => ({ client: userClient, error: state.authenticated ? null : new Error('Unauthorized') }),
    },
    '@masarx/auth/server': { createServerReachableFetch: () => null },
    '@masarx/config': { getPublicConfig: () => ({ supabaseUrl: 'https://example.test', supabaseAnonKey: 'test-anon' }) },
    './request-meta': {
      getRequestIdFromHeaders: () => 'request-id',
      jsonResponseWithRequestId: (body: unknown, status: number) => Response.json(body, { status }),
    },
  };
  dependencies['./resource-import-worker'] = {
    parseUploadInWorker: async (buffer: ArrayBuffer, format: string, preferred?: string | null) => {
      if (format === 'csv') {
        const guard = load<{ parseBoundedCsv: (file: File) => Promise<string[][]>; matrixToTabularData: (matrix: unknown[][]) => { headers: string[]; rows: unknown[] } }>('supabase/functions/resource-import-studio/upload-limits.ts');
        return { ...guard.matrixToTabularData(await guard.parseBoundedCsv(new File([buffer], 'import.csv'))), selectedSheet: 'Sheet1', visibleSheets: ['Sheet1'] };
      }
      const guard = load<{ assertXlsxExpansionLimits: (buffer: ArrayBuffer, zip: typeof JSZip) => Promise<void> }>('supabase/functions/resource-import-studio/upload-limits.ts');
      await guard.assertXlsxExpansionLimits(buffer, JSZip);
      const workbook = new TracedWorkbook(); await workbook.xlsx.load(buffer);
      const api = dependencies['@masarx/api'] as {
        detectWorkbookVisibleSheets: (value: unknown) => string[];
        worksheetToMatrix: (value: unknown) => unknown[][];
        matrixToTabularData: (matrix: unknown[][]) => { headers: string[]; rows: unknown[] };
      };
      const visibleSheets = api.detectWorkbookVisibleSheets(workbook);
      const selectedSheet = preferred && visibleSheets.includes(preferred) ? preferred : visibleSheets[0]!;
      return { ...api.matrixToTabularData(api.worksheetToMatrix(workbook.getWorksheet(selectedSheet))), selectedSheet, visibleSheets };
    },
  };
  const load = tsLoader({ Deno: { serve: (handler: RequestHandler) => { edgeHandler = handler; } }, process: { env } }, dependencies);
  dependencies['@masarx/api'] = load('packages/api/src/tabular-import.ts');
  let handler: RequestHandler;
  if (kind === 'edge') {
    load('supabase/functions/resource-import-studio/index.ts');
    if (!edgeHandler) throw new Error('Edge entrypoint did not register its handler');
    handler = edgeHandler;
  } else {
    handler = load<{ handleResourceImportRequest: RequestHandler }>('apps/shared/resource-import-route.ts').handleResourceImportRequest;
  }
  const invoke = async (payload: FormData | Record<string, unknown>) => {
    const response = await handler(new Request('https://example.test/api/resource-import', {
      method: 'POST', ...(payload instanceof FormData ? { body: payload } : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }),
    }));
    return { status: response.status, body: await response.json() as SuccessfulResponse };
  };
  const prepare = (contents: BlobPart, overrides: Record<string, string> = {}) => {
    const form = new FormData();
    form.set('action', 'prepare'); form.set('resource_key', 'recipients');
    form.set('file', new File([contents], overrides.fileName || 'recipients.csv'));
    for (const [key, value] of Object.entries(overrides)) if (key !== 'fileName') form.set(key, value);
    return invoke(form);
  };
  return { state, events, userRpc, serviceRpc, upload, signed, invoke, prepare, resource, handler };
}

describe.each(['edge', 'browser server'])('%s import lifecycle', (kind) => {
  let h: ReturnType<typeof harness>;
  beforeEach(() => { h = harness(kind); });
  const expectNoUpload = () => {
    expect(h.upload).not.toHaveBeenCalled();
    expect(h.userRpc.mock.calls.some(([name]) => name === 'tabular_import_prepare_v1')).toBe(false);
  };

  test('request trust/authentication fails before any user, service or storage I/O', async () => {
    if (kind === 'edge') h.state.authenticated = false;
    else h.state.trusted = false;
    expect((await h.prepare('External ID\na\n')).status).toBe(kind === 'edge' ? 401 : 403);
    expect(h.userRpc).not.toHaveBeenCalled();
    expect(h.serviceRpc).not.toHaveBeenCalled();
    expect(h.upload).not.toHaveBeenCalled();
  });

  test('empty bytes fail before registry access or storage', async () => {
    expect((await h.prepare('')).status).toBe(400);
    expect(h.userRpc).not.toHaveBeenCalled(); expectNoUpload();
  });
  test.each([['headers only', 'External ID\n'], ['unreadable headers', ',\n,\n']])('%s fails before upload', async (_label, contents) => {
    expect((await h.prepare(contents)).status).toBe(422); expectNoUpload();
  });
  test('resolved policy bytes are checked before parsing an XLSX workbook', async () => {
    h.state.policy.max_file_size_bytes = 4;
    expect((await h.prepare('not-a-workbook', { fileName: 'recipients.xlsx' })).status).toBe(413);
    expect(h.events).not.toContain('workbook:parse'); expectNoUpload();
  });
  test.each(['inflate', 'lying-inflate', 'dense', 'entries', 'csv'])('rejects %s before ExcelJS, storage or import RPC', async (attack) => {
    h.state.policy.max_file_size_bytes = 20 * 1024 * 1024;
    let bytes: BlobPart;
    const csv = attack === 'csv';
    if (csv) bytes = new Uint8Array(10 * 1024 * 1024 + 1);
    else {
      const zip = new JSZip();
      if (attack === 'entries') for (let index = 0; index < 4097; index++) zip.file(`entry${index}`, '');
      else zip.file(attack === 'dense' ? 'xl/worksheets/sheet1.xml' : 'media.bin',
        attack === 'dense' ? '<c/>'.repeat(100001) : 'x'.repeat(16 * 1024 * 1024 + 1));
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      if (attack === 'lying-inflate') {
        const central = buffer.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
        buffer.writeUInt32LE(1, central + 24); buffer.writeUInt32LE(1, 22);
      }
      bytes = buffer;
    }
    const result = await h.prepare(bytes, { fileName: csv ? 'recipients.csv' : 'recipients.xlsx' });
    expect(result.status).toBe(['dense', 'entries'].includes(attack) ? 422 : 413);
    expect(JSON.stringify(result.body)).toMatch(/[\u0600-\u06ff]/);
    expect(h.events).not.toContain('workbook:parse'); expectNoUpload();
  });
  test('oversized Content-Length is rejected before multipart parsing', async () => {
    const request = new Request('https://example.test/api/resource-import', {
      method: 'POST', headers: { 'content-type': 'multipart/form-data; boundary=test', 'content-length': String(10 * 1024 * 1024 + 1) }, body: 'unparsed',
    });
    const formData = jest.spyOn(request, 'formData');
    const response = await h.handler(request);
    expect(response.status).toBe(413);
    expect(JSON.stringify(await response.json())).toMatch(/[\u0600-\u06ff]/);
    expect(formData).not.toHaveBeenCalled(); expectNoUpload();
  });
  test.each(['xlsx', 'csv'])('no Content-Length cannot bypass the %s file-size cap', async (extension) => {
    h.state.policy.max_file_size_bytes = 20 * 1024 * 1024;
    const form = new FormData();
    form.set('action', 'prepare'); form.set('resource_key', 'recipients');
    form.set('file', new File([new Uint8Array(10 * 1024 * 1024 + 1)], `recipients.${extension}`));
    const request = new Request('https://example.test/api/resource-import', { method: 'POST', body: form });
    expect(request.headers.has('content-length')).toBe(false);
    const formData = jest.spyOn(request, 'formData');
    const response = await h.handler(request);
    expect(response.status).toBe(413);
    expect(JSON.stringify(await response.json())).toMatch(/[\u0600-\u06ff]/);
    expect(formData).toHaveBeenCalledTimes(1);
    expect(h.userRpc).not.toHaveBeenCalled();
    expect(h.events).not.toContain('workbook:parse'); expectNoUpload();
  });
  test.each(['far-cell', 'far-row', 'dimension'])('rejects %s worksheet before workbook load or matrix conversion', async (attack) => {
    const workbook = new Workbook(); workbook.addWorksheet('Data').addRow(['External ID']);
    const zip = await JSZip.loadAsync(await workbook.xlsx.writeBuffer());
    const xml = attack === 'far-cell' ? '<worksheet><sheetData><row r="1"><c r="XFD1048576"/></row></sheetData></worksheet>'
      : attack === 'far-row' ? '<worksheet><sheetData><row r="1048576"/></sheetData></worksheet>'
      : '<worksheet><dimension ref="A1:XFD1048576"/><sheetData><row r="1"><c r="A1"/></row></sheetData></worksheet>';
    zip.file('xl/worksheets/sheet1.xml', xml);
    const result = await h.prepare(await zip.generateAsync({ type: 'nodebuffer' }), { fileName: 'sparse.xlsx' });
    expect(result.status).toBe(422); expect(JSON.stringify(result.body)).toContain('import_dimensions');
    expect(h.events).not.toContain('workbook:parse'); expectNoUpload();
  });
  test.each([[10001, 1], [1, 257], [10000, 201]])('matrix defense rejects runtime dimensions %s x %s before getRow', async (rows, columns) => {
    const workbook = new Workbook(); const sheet = workbook.addWorksheet('Data');
    sheet.addRow(['External ID']); sheet.addRow(['id-1']);
    h.state.matrixDimensions = { rows, columns };
    const result = await h.prepare(await workbook.xlsx.writeBuffer(), { fileName: 'matrix.xlsx' });
    expect(result.status).toBe(422); expect(JSON.stringify(result.body)).toContain('import_dimensions');
    expect(h.events).toContain('workbook:parse'); expect(h.events).not.toContain('matrix:row'); expectNoUpload();
  });
  test('resource byte and row limits may tighten but never loosen the resolved policy', async () => {
    h.resource.import.max_file_bytes = 1000000;
    h.resource.import.max_rows = 1;
    expect((await h.prepare('External ID\na\nb\n')).status).toBe(413); expectNoUpload();
  });
  test('resolved row policy is enforced even with a looser registry limit', async () => {
    h.state.policy.max_rows = 1; h.resource.import.max_rows = 100;
    expect((await h.prepare('External ID\na\nb\n')).status).toBe(413); expectNoUpload();
  });
  test.each(['ui_read_registry_v1', 'ui_resolve_import_scope_context_v1', 'ui_tabular_import_profiles_v1', 'resolve_tabular_import_policy_v1'])('failed %s cannot fall through to an upload', async (name) => {
    h.state.errors[name] = 'permission denied';
    expect((await h.prepare('External ID\na\n')).status).toBe(400); expectNoUpload();
  });
  test('unregistered and disabled resources fail closed', async () => {
    h.resource.import.enabled = false;
    expect((await h.prepare('External ID\na\n')).status).toBe(422); expectNoUpload();
  });
  test('a missing or invalid policy is not treated as unlimited', async () => {
    h.state.policy = {};
    expect((await h.prepare('External ID\na\n')).status).toBe(422); expectNoUpload();
  });
  test('unmatched headers require an exact registered profile with actual field rules', async () => {
    h.state.profiles = [{ header_fingerprint: 'other', mapping_config: { field_rules: [{ target_field: 'external_id' }] } }];
    expect((await h.prepare('Opaque\na\n')).status).toBe(422); expectNoUpload();
    h.state.profiles[0]!.header_fingerprint = 'opaque';
    expect((await h.prepare('Opaque\na\n')).status).toBe(200);
    expect(h.userRpc).toHaveBeenCalledWith('ui_tabular_import_profiles_v1', { p_resource: 'recipients', p_scope_context: { tenant: orgId } });
  });
  test('manual empty mapping cannot be disguised by a matching automatic profile', async () => {
    h.state.profiles = [{ header_fingerprint: 'opaque', mapping_config: { field_rules: [{ target_field: 'external_id' }] } }];
    expect((await h.prepare('Opaque\na\n', { rule_source: 'manual' })).status).toBe(422); expectNoUpload();
  });
  test('registered aliases prepare all original rows and upload the entire original file', async () => {
    const contents = 'Recipient code\n' + Array.from({ length: 501 }, (_, index) => `value-${index}`).join('\n');
    const result = await h.prepare(contents);
    expect(result.status).toBe(200); expect(result.body.dry_run.total_rows).toBe(501);
    const args = h.userRpc.mock.calls.find(([name]) => name === 'tabular_import_prepare_v1')![1].p_payload!;
    expect(args.rows).toHaveLength(501); expect(args.rows[500]!['Recipient code']).toBe('value-500');
    expect(args.rules).toEqual([{ source_column: 'Recipient code', target_field: 'external_id', enabled: true }]);
    expect(await h.upload.mock.calls[0]![1].text()).toBe(contents);
    expect(h.events.indexOf('user:ui_tabular_import_profiles_v1')).toBeLessThan(h.events.indexOf('storage:upload'));
  });
  test('inline related columns use registered node prefixes, not guessed resource names', async () => {
    h.resource.columns.push({ key: 'address_id', import: { enabled: true, reference: { resource: 'addresses', allow_inline_node: true, inline_node_key: 'destination', mapping_prefixes: ['Destination'] } } });
    h.state.registry.resources.push({ key: 'addresses', columns: [{ key: 'city', label: 'City', import: { enabled: true } }] });
    expect((await h.prepare('Destination City\nRiyadh\n')).status).toBe(200);
    const args = h.userRpc.mock.calls.find(([name]) => name === 'tabular_import_prepare_v1')![1].p_payload!;
    expect(args.rules).toEqual([{ source_column: 'Destination City', target_field: 'destination.city', enabled: true }]);
  });
  test('XLSX preparation reads every server-side row and preserves full-file bytes', async () => {
    const workbook = new Workbook(); const sheet = workbook.addWorksheet('Sheet1');
    sheet.addRow(['External ID']); for (let index = 0; index < 501; index += 1) sheet.addRow([`xlsx-${index}`]);
    const bytes = await workbook.xlsx.writeBuffer();
    expect((await h.prepare(bytes, { fileName: 'recipients.xlsx' })).status).toBe(200);
    const args = h.userRpc.mock.calls.find(([name]) => name === 'tabular_import_prepare_v1')![1].p_payload!;
    expect(args.rows).toHaveLength(501); expect(args.rows[500]!['External ID']).toBe('xlsx-500');
    expect(Buffer.from(await h.upload.mock.calls[0]![1].arrayBuffer())).toEqual(Buffer.from(bytes));
  });
  test('malformed row override JSON fails before storage', async () => {
    expect((await h.prepare('External ID\na\n', { row_overrides: '{' })).status).toBe(400); expectNoUpload();
  });
  test('missing registered artifact prevents preparation despite a successful upload', async () => {
    h.state.artifactResult = null;
    expect((await h.prepare('External ID\na\n')).status).toBe(400);
    expect(h.upload).toHaveBeenCalledTimes(1);
    expect(h.serviceRpc).toHaveBeenCalledWith('register_artifact_v1', expect.any(Object));
    expect(h.userRpc.mock.calls.some(([name]) => name === 'tabular_import_prepare_v1')).toBe(false);
  });
  test('start authorizes first, runs one bounded existing batch, then reads canonical user-visible state', async () => {
    const result = await h.invoke({ action: 'start', run_id: runId });
    expect(result.status).toBe(200); expect(result.body.run.status).toBe('completed');
    expect(result.body.run.id).toBe(runId);
    expect(result.body.report).toEqual(h.state.run.report);
    expect(h.events).toEqual(['user:ui_start_tabular_import_run_v1', 'service:process_tabular_import_run_v1', 'user:ui_get_tabular_import_run_v1']);
    expect(h.serviceRpc).toHaveBeenCalledWith('process_tabular_import_run_v1', { p_run_id: runId, p_batch_size: 100 });
  });
  test('a denied start never invokes the privileged processor', async () => {
    h.state.errors.ui_start_tabular_import_run_v1 = 'permission denied';
    expect((await h.invoke({ action: 'start', run_id: runId })).status).toBe(400);
    expect(h.serviceRpc).not.toHaveBeenCalled();
  });
  test('kickoff failure returns the actual durable run with a warning, not fictional completion', async () => {
    h.state.errors.process_tabular_import_run_v1 = 'temporarily unavailable';
    h.state.run.status = 'queued'; h.state.run.report = null;
    const result = await h.invoke({ action: 'start', run_id: runId });
    expect(result.status).toBe(200); expect(result.body.run.status).toBe('queued');
    expect(result.body.processing_warning).toMatch(/initial processing/); expect(result.body.report).toBeNull();
  });
  test('terminal canonical readback clears a kickoff failure warning after concurrent completion', async () => {
    h.state.errors.process_tabular_import_run_v1 = 'temporarily unavailable';
    const result = await h.invoke({ action: 'start', run_id: runId });
    expect(result.status).toBe(200);
    expect(result.body.run.status).toBe('completed');
    expect(result.body.processing_warning).toBeNull();
    expect(result.body.report).toEqual({ id: 'report' });
  });
  test('mismatched or unavailable canonical readback never claims a successful start', async () => {
    h.state.run.id = 'wrong-run';
    expect((await h.invoke({ action: 'start', run_id: runId })).status).toBe(400);
  });
  test.each([undefined, '', '   '])('cancellation rejects blank reason %p before RPC', async (reason) => {
    expect((await h.invoke({ action: 'cancel', run_id: runId, reason })).status).toBe(400);
    expect(h.userRpc).not.toHaveBeenCalled();
  });
  test.each(['canceled', 'completed', 'completed_with_errors', 'failed'])('cancellation forwards reason and returns untouched canonical %s readback', async (status) => {
    h.state.run.status = status; h.state.run.summary = { cancellation: { reason: 'original reason' } };
    const result = await h.invoke({ action: 'cancel', run_id: runId, reason: '  operator reason  ' });
    expect(result.status).toBe(200); expect(result.body.run.status).toBe(status);
    expect(result.body.run.summary.cancellation.reason).toBe('original reason');
    expect(h.userRpc).toHaveBeenCalledWith('ui_cancel_tabular_import_run_v1', { p_run_id: runId, p_cancel_reason: 'operator reason' });
  });
  test('tenant/capability cancellation denial remains a failed response', async () => {
    h.state.errors.ui_cancel_tabular_import_run_v1 = 'permission denied';
    expect((await h.invoke({ action: 'cancel', run_id: runId, reason: 'operator reason' })).status).toBe(400);
    expect(h.serviceRpc).not.toHaveBeenCalled();
  });
});

describe('import smoke approval start boundary', () => {
  const identity = { id: runId, organization_id: orgId, scope_context: { tenant: orgId } };
  function approvalHarness(body: unknown = { ok: true, run: { ...identity, status: 'completed' } }, httpStatus = 200, requestedRunId: unknown = runId) {
    const events: string[] = [];
    const request = { method: () => 'POST', postDataJSON: () => ({ action: 'start', run_id: requestedRunId }) };
    const response = {
      request: () => request, url: () => 'https://example.test/api/resource-import',
      ok: () => httpStatus >= 200 && httpStatus < 300, status: () => httpStatus,
      json: async () => body,
    };
    const page = {
      waitForResponse: jest.fn((predicate: (candidate: typeof response) => boolean) => {
        events.push('listen');
        expect(predicate(response)).toBe(true);
        return Promise.resolve(response);
      }),
      getByRole: jest.fn(() => ({ click: async () => { events.push('approve'); } })),
    };
    const worker = jest.fn();
    const load = tsLoader({ process: { cwd: () => root, execPath: process.execPath, env: {} } }, {
      fs: { default: fs }, path: { default: path }, child_process: { execFileSync: worker },
      '@playwright/test': { expect: (value: unknown) => expect(value) },
    });
    const helper = load<{ approveResourceImport: (page: unknown) => Promise<typeof identity> }>('tests/e2e/utils/resource-import.ts');
    return { helper, page, response, worker, events };
  }

  test.each(['queued', 'processing', 'completed'])('accepts exact confirmed %s start and drives only active work', async (status) => {
    const h = approvalHarness({ ok: true, run: { ...identity, status } });
    await expect(h.helper.approveResourceImport(h.page)).resolves.toEqual(identity);
    expect(h.events).toEqual(['listen', 'approve']);
    expect(h.page.getByRole).toHaveBeenCalledWith('button', { name: 'Approve and import' });
    expect(h.worker).toHaveBeenCalledTimes(status === 'completed' ? 0 : 1);
    if (status !== 'completed') {
      expect(h.worker).toHaveBeenCalledWith(process.execPath, ['scripts/workers/tabular-import-worker.js', '--once'], expect.any(Object));
    }
  });

  test.each([
    ['HTTP rejection', { ok: true, run: { ...identity, status: 'queued' } }, 403, runId],
    ['unsuccessful envelope', { ok: false, run: { ...identity, status: 'queued' } }, 200, runId],
    ['missing envelope', null, 200, runId],
    ['missing run', { ok: true }, 200, runId],
    ['different run', { ok: true, run: { ...identity, id: 'another-run', status: 'queued' } }, 200, runId],
    ['missing requested identity', { ok: true, run: { ...identity, id: undefined, status: 'queued' } }, 200, null],
    ['blank requested identity', { ok: true, run: { ...identity, id: ' ', status: 'queued' } }, 200, ' '],
    ['missing organization identity', { ok: true, run: { ...identity, organization_id: undefined, status: 'queued' } }, 200, runId],
    ['invalid organization identity', { ok: true, run: { ...identity, organization_id: 'foreign', status: 'queued' } }, 200, runId],
    ...['failed', 'canceled', 'cancelled', 'completed_with_errors', 'unknown', undefined].map((status) => [
      `unacceptable ${status} state`, { ok: true, run: { ...identity, status } }, 200, runId,
    ]),
  ] as Array<[string, unknown, number, unknown]>)('rejects %s without running the worker', async (_name, body, httpStatus, requestedRunId) => {
    const h = approvalHarness(body, httpStatus, requestedRunId);
    await expect(h.helper.approveResourceImport(h.page)).rejects.toThrow();
    expect(h.worker).not.toHaveBeenCalled();
  });

  test('response listener ignores other routes, methods, actions and malformed bodies', async () => {
    const h = approvalHarness();
    await h.helper.approveResourceImport(h.page);
    const matches = h.page.waitForResponse.mock.calls[0]![0];
    expect(matches({ ...h.response, url: () => 'https://example.test/api/other' })).toBe(false);
    expect(matches({ ...h.response, request: () => ({ method: () => 'GET', postDataJSON: () => ({ action: 'start', run_id: runId }) }) })).toBe(false);
    expect(matches({ ...h.response, request: () => ({ method: () => 'POST', postDataJSON: () => ({ action: 'get_run', run_id: runId }) }) })).toBe(false);
    expect(matches({ ...h.response, request: () => ({ method: () => 'POST', postDataJSON: () => { throw new Error('not JSON'); } }) })).toBe(false);
    expect(h.worker).not.toHaveBeenCalled();
  });
});

describe.each(['edge', 'browser'])('API client %s cancellation boundary', (kind) => {
  function client(response: Response) {
    const fetch = jest.fn<Promise<Response>, [RequestInfo | URL, RequestInit]>().mockResolvedValue(response);
    const load = tsLoader({ fetch, ...(kind === 'browser' ? { window: {} } : {}) }, {
      './rpc': { createRpc: () => jest.fn() }, './scope-normalize': { normalizeUiScopeType: (value: unknown) => value },
      './marketplace-client': { attachMarketplaceClient: () => ({}) }, './settings-change-compat': {},
      '@masarx/config': { getPublicConfig: () => ({ supabaseUrl: 'https://example.test', supabaseAnonKey: 'test-anon' }) },
    });
    return { fetch, ui: load<UiClientExports>('packages/api/src/ui-client.ts').createUiClientFromSupabase({ auth: { getSession: async () => ({ data: { session: { access_token: 'synthetic-session' } } }) } }) };
  }
  test('sends the trimmed operator reason and exact run id', async () => {
    const h = client(Response.json({ ok: true, run: { id: runId } }));
    await h.ui.resourceImports.cancel({ runId, reason: '  reason  ' });
    expect(JSON.parse(String(h.fetch.mock.calls[0]![1].body))).toEqual({ action: 'cancel', run_id: runId, reason: 'reason' });
  });
  test('an HTTP error JSON envelope cannot masquerade as success', async () => {
    const body = kind === 'edge' ? { error: { message: 'permission denied' } } : { error: 'permission denied' };
    const h = client(Response.json(body, { status: 403 }));
    await expect(h.ui.resourceImports.cancel({ runId, reason: 'reason' })).rejects.toThrow('permission denied');
  });
});
