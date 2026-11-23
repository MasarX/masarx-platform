const { createHash, randomUUID } = require('node:crypto');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');
const { runInNewContext } = require('node:vm');
const ts = require('typescript');
const yaml = require('yaml');

const source = readFileSync(resolve(__dirname, '../../../supabase/functions/api-caller/index.ts'), 'utf8');
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
});
const supabaseImport = ts.preProcessFile(source, true).importedFiles
  .find(({ fileName }) => fileName.startsWith('npm:@supabase/supabase-js@')).fileName;
const fixtureHost = name => [name, 'example', 'test'].join('.');
const httpsPrefix = ['https:', '', ''].join('/');
const providerHost = fixtureHost('provider');
const target = `${httpsPrefix}${providerHost}/call`;
const proxyUrl = `${httpsPrefix}${fixtureHost('proxy')}`;
const publicIpv4 = [8, 8, 8, 8].join('.');
const loopbackIpv4 = [127, 0, 0, 1].join('.');
const jobId = randomUUID();
const leaseToken = randomUUID();
let modules;

beforeAll(async () => {
  modules = {
    './egress.mjs': await import('../../../supabase/functions/api-caller/egress.mjs'),
    './invocation.mjs': await import('../../../supabase/functions/api-caller/invocation.mjs'),
    './proxy.mjs': await import('../../../supabase/functions/api-caller/proxy.mjs'),
    './renderer-auth.mjs': {},
    './auth.mjs': {
      authorizeEdgeRequest: async () => ({ ok: true }),
      authorizeApiCallerOperation: () => ({ ok: true }),
    },
  };
});

afterEach(() => jest.restoreAllMocks());

function loadWorker({ env = {}, answers = { A: [publicIpv4], AAAA: [] }, spec = {}, policy = {}, reply } = {}) {
  const config = {
    EDGE_SUPABASE_URL: `${httpsPrefix}${fixtureHost('database')}`,
    EDGE_SUPABASE_ANON_KEY: ['anon', 'fixture'].join('-'),
    API_CALLER_DB_JWT: Array(3).fill('fixture').join('.'),
    ...env,
  };
  const rpc = async name => ({
    claim_edge_job_by_id_v1: { data: [{ job_id: jobId, lease_token: leaseToken }] },
    get_claimed_edge_job_call_spec_v1: { data: { url: target, method: 'GET', ...spec } },
    resolve_effective_outbound_egress_policy_v1: { data: { enforce: true, policy } },
  })[name] ?? {};
  const deps = {
    ...modules,
    [supabaseImport]: { createClient: () => ({ rpc }) },
    './_shared/mod.mjs': { readEnv: key => config[key]?.trim() ?? '' },
  };
  const fetch = jest.spyOn(globalThis, 'fetch').mockImplementation(async () => reply ?? new Response('ok'));
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  const resolveDns = jest.fn(async (_host, type) => {
    const answer = answers[type];
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const client = {};
  const createHttpClient = jest.fn(() => client);
  const exports = {};
  let handler;
  runInNewContext(outputText, {
    exports, require: name => deps[name], Error, URL, Headers, Response, TextEncoder, fetch,
    Deno: { env: { get: key => config[key] }, resolveDns, createHttpClient, serve: fn => { handler = fn; } },
  });
  const invoke = async ({ headers = {}, payload = {} } = {}) => {
    const response = await handler(new Request(`${httpsPrefix}${fixtureHost('worker')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ job_id: jobId, ...payload }),
    }));
    return { status: response.status, data: await response.json() };
  };
  return { invoke, fetch, warn, resolveDns, createHttpClient, client };
}

const dev = { EDGE_ENVIRONMENT: 'dev' };
const bypassLog = 'egress_proxy_bypassed_dev';

test.each(['stg', 'prod', undefined, 'unknown', ' dev '])('requires the proxy in environment %s', async environment => {
  const worker = loadWorker({ env: { EDGE_ENVIRONMENT: environment } });
  const { status, data } = await worker.invoke();
  expect(status).toBe(502);
  expect(data.result.error).toContain('guarded proxy transport is unavailable');
  expect(worker.resolveDns).not.toHaveBeenCalled();
  expect(worker.fetch).not.toHaveBeenCalled();
  expect(worker.warn).not.toHaveBeenCalled();
});

test('uses the configured proxy in DEV', async () => {
  const worker = loadWorker({ env: { ...dev, API_CALLER_GUARDED_EGRESS_PROXY_URL: proxyUrl } });
  expect((await worker.invoke()).status).toBe(200);
  expect(worker.createHttpClient).toHaveBeenCalledWith({ proxy: { url: proxyUrl } });
  expect(worker.fetch).toHaveBeenCalledWith(target, expect.objectContaining({ client: worker.client, redirect: 'manual' }));
  expect(worker.warn).not.toHaveBeenCalled();
});

test.each([
  { API_CALLER_GUARDED_EGRESS_PROXY_URL: '' },
  { API_CALLER_GUARDED_EGRESS_PROXY_USERNAME: ['fixture', 'user'].join('-') },
])('requires a working proxy when any proxy setting is present', async settings => {
  const worker = loadWorker({ env: { ...dev, ...settings } });
  expect((await worker.invoke()).status).toBe(502);
  expect(worker.fetch).not.toHaveBeenCalled();
  expect(worker.warn).not.toHaveBeenCalled();
});

test('checks both DNS families and logs one fixed code before direct dispatch in DEV', async () => {
  const noRecord = Object.assign(new Error('no AAAA record'), { name: 'NotFound' });
  const worker = loadWorker({ env: dev, answers: { A: [publicIpv4], AAAA: noRecord } });
  expect((await worker.invoke()).status).toBe(200);
  expect(worker.resolveDns.mock.calls.map(([host, type]) => [host, type]))
    .toEqual([[providerHost, 'A'], [providerHost, 'AAAA']]);
  expect(worker.fetch).toHaveBeenCalledWith(target, expect.objectContaining({ redirect: 'manual' }));
  expect(worker.createHttpClient).not.toHaveBeenCalled();
  expect(worker.warn.mock.calls).toEqual([[bypassLog]]);
  expect(worker.warn.mock.invocationCallOrder[0]).toBeLessThan(worker.fetch.mock.invocationCallOrder[0]);
});

test.each([
  [10, 1, 2, 3].join('.'),
  [172, 16, 1, 2].join('.'),
  [192, 168, 1, 2].join('.'),
  loopbackIpv4,
  [169, 254, 10, 1].join('.'),
  [169, 254, 169, 254].join('.'),
  [100, 64, 0, 1].join('.'),
  [0, 0, 0, 0].join('.'),
  [224, 0, 0, 1].join('.'),
  ['fc00', '', '1'].join(':'),
  ['fd00', 'ec2', '', '254'].join(':'),
  ['fe80', '', '1'].join(':'),
  ['', '', '1'].join(':'),
  ['', '', ''].join(':'),
  ['ff02', '', '1'].join(':'),
  ['', '', 'ffff', loopbackIpv4].join(':'),
  ['', '', 'ffff', publicIpv4].join(':'),
])('refuses a DNS answer containing %s in DEV', async address => {
  const answers = address.includes(':') ? { A: [], AAAA: [address] } : { A: [address], AAAA: [] };
  const worker = loadWorker({ env: dev, answers });
  const { status, data } = await worker.invoke();
  expect(status).toBe(502);
  expect(data.result.error).toContain('non-public address');
  expect(worker.fetch).not.toHaveBeenCalled();
  expect(worker.warn).not.toHaveBeenCalled();
});

test.each([
  [{ A: [publicIpv4], AAAA: [['fd00', '', '1'].join(':')] }, 'non-public address'],
  [{ A: [publicIpv4], AAAA: new Error('DNS failure') }, 'AAAA DNS lookup failed'],
  [{ A: [], AAAA: [] }, 'DNS produced no addresses'],
])('refuses DEV DNS answers that fail validation', async (answers, message) => {
  const worker = loadWorker({ env: dev, answers });
  const { status, data } = await worker.invoke();
  expect(status).toBe(502);
  expect(data.result.error).toContain(message);
  expect(worker.fetch).not.toHaveBeenCalled();
  expect(worker.warn).not.toHaveBeenCalled();
});

test('honors the existing approved HTTP hostname rule in DEV', async () => {
  const url = target.replace('https:', 'http:');
  const unapproved = loadWorker({ env: dev, spec: { url } });
  expect((await unapproved.invoke()).data.result.error).toContain('only https');
  expect(unapproved.fetch).not.toHaveBeenCalled();

  const approved = loadWorker({ env: dev, spec: { url, http_allowed_host: new URL(url).hostname } });
  expect((await approved.invoke()).status).toBe(200);
  expect(approved.fetch).toHaveBeenCalledWith(url, expect.objectContaining({ redirect: 'manual' }));
});

test('never follows redirects during the DEV bypass even when the job policy allows redirects', async () => {
  const worker = loadWorker({
    env: dev,
    policy: { follow_redirects: true },
    reply: new Response(null, { status: 302, headers: { location: `${httpsPrefix}${fixtureHost('other')}/` } }),
  });
  expect((await worker.invoke()).data.result.status).toBe(302);
  expect(worker.fetch).toHaveBeenCalledTimes(1);
  expect(worker.warn.mock.calls).toEqual([[bypassLog]]);
});

test('ignores environment claims in request headers and server-resolved job fields', async () => {
  const worker = loadWorker({ spec: { EDGE_ENVIRONMENT: 'dev', environment: 'dev' } });
  const { status, data } = await worker.invoke({ headers: { 'edge-environment': 'dev', 'x-edge-environment': 'dev' } });
  expect(status).toBe(502);
  expect(data.result.error).toContain('guarded proxy transport is unavailable');
  expect(worker.fetch).not.toHaveBeenCalled();
  expect(worker.warn).not.toHaveBeenCalled();

  const invalid = await worker.invoke({ payload: { EDGE_ENVIRONMENT: 'dev' } });
  expect(invalid.status).toBe(422);
});

test('DEV deploy writes the environment marker and verifies its digest before uploading functions', () => {
  const deployPath = resolve(__dirname, '../../../.github/workflows/deploy.yml');
  const workflow = yaml.parse(readFileSync(deployPath, 'utf8'));
  const { run } = workflow.jobs.database.steps.find(step => step.id === 'deploy');
  const write = 'if [[ "$DEPLOY_ENV" == dev ]]; then\n  printf \'EDGE_ENVIRONMENT=%s\\n\' "$DEPLOY_ENV" >> "$secret_file"\nfi';
  expect(run).toContain(write);
  expect(run.indexOf(write)).toBeLessThan(run.indexOf('secrets set'));
  const verifier = [...run.matchAll(/secrets list[^\n]+\|\n\s+node -e '([\s\S]+?)' 2>\/dev\/null/g)].at(-1);
  expect(verifier.index).toBeLessThan(run.indexOf('functions deploy'));
  const digest = value => createHash('sha256').update(value).digest('hex');
  const credentials = ['LABEL_RENDERER_SIGNING_KEY', 'LABEL_RENDERER_GATEWAY_JWT'];
  const local = [...credentials.map(name => `${name}=fixture`), 'EDGE_ENVIRONMENT=dev'].join('\n');
  const listed = credentials.map(name => ({ name, value: digest('fixture') }));
  const verify = (environment, marker) => {
    const entries = marker === undefined ? listed : [...listed, { name: 'EDGE_ENVIRONMENT', value: digest(marker) }];
    const dependencies = name => name === 'node:fs'
      ? { readFileSync: file => file === 0 ? JSON.stringify(entries) : local }
      : { createHash };
    const runtime = { env: { DEPLOY_ENV: environment, EDGE_SECRET_FILE: 'fixture.env' }, exit: () => { throw new Error('digest mismatch'); } };
    new Function('require', 'process', verifier[1])(dependencies, runtime);
  };
  expect(() => verify('dev', 'dev')).not.toThrow();
  expect(() => verify('dev', 'stg')).toThrow('digest mismatch');
  expect(() => verify('dev')).toThrow('digest mismatch');
});
