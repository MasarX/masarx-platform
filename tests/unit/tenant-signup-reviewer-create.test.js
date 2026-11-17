const fs = require('fs');
const path = require('path');
const vm = require('vm');
const ts = require('typescript');
const React = require('react');
const { renderToStaticMarkup } = require('react-dom/server');

const repoRoot = path.join(__dirname, '../..');
const requestId = '739ab3ed-cc23-4cb8-9d42-9270c86e0f94';
const rpc = jest.fn();
const me = jest.fn();
const verifySession = jest.fn();
const revalidatePath = jest.fn();

function loadComponent(relativePath, imports) {
  const filename = path.join(repoRoot, relativePath);
  const source = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, target: ts.ScriptTarget.ES2022 },
  }).outputText;
  const compiledModule = { exports: {} };
  vm.runInNewContext(source, {
    module: compiledModule,
    exports: compiledModule.exports,
    require: (name) => Object.hasOwn(imports, name) ? imports[name] : require(name),
    URL, URLSearchParams, process,
  }, { filename });
  return compiledModule.exports;
}

const pageImports = {
  'server-only': {},
  '@masarx/api/server': { createUiServerClient: () => ({ me, rpc }) },
  '@masarx/api': {},
  '@masarx/auth/server': { getVerifiedAccessToken: verifySession },
  '@masarx/config': {},
  'next/cache': { revalidatePath },
  './badge': { Badge: 'badge' },
  './resource-page': { ResourcePage: 'resource-page' },
  './section': { Section: 'section' },
  './tenant-signup-review-form': { TenantSignupReviewForm: 'review-form' },
  './tenant-signup-request-create-form': { TenantSignupRequestCreateForm: 'create-form' },
  './utils': { formatUiError: (_error, fallback) => fallback },
  './capabilities': {
    resolveCapabilitySet: (caps) => caps,
    hasCapability: (caps, key) => caps.includes(key),
  },
};
const { TenantSignupRequestsPage } = loadComponent('packages/ui/src/tenant-signup-requests-page.tsx', pageImports);

function findElement(node, type) {
  if (!node || typeof node !== 'object') return null;
  if (node.type === type) return node;
  for (const child of React.Children.toArray(node.props?.children)) {
    const found = findElement(child, type);
    if (found) return found;
  }
  return null;
}

async function page() {
  return TenantSignupRequestsPage({
    appKey: 'console', searchParams: {}, appBasePath: '',
    baseHref: '/organizations/requests', testIdPrefix: 'requests',
  });
}

function input(overrides = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries({
    email: ' Person@Example.com ', full_name: ' Person ', organization_name: ' Organization ',
    organization_slug: ' prospect ', phone: ' +12025550123 ', locale: ' ar ', notes: ' reviewer notes ',
    created_by_user_id: 'spoofed-user', organization_id: 'another-tenant', turnstile_verified: 'true',
    ...overrides,
  })) form.set(key, value);
  return form;
}

beforeEach(() => {
  jest.clearAllMocks();
  me.mockResolvedValue({ access_scope: { scope_type: 'platform' }, capabilities: ['tenant_signup_requests.review'] });
  verifySession.mockResolvedValue({ accessToken: 'verified-session', error: null });
  rpc.mockResolvedValue({ ok: true, id: requestId, status: 'pending' });
});

test.each([
  ['platform', ['tenant_signup_requests.review'], true],
  ['tenant', ['tenant_signup_requests.review'], false],
  ['platform', [], false],
])('create form is available only to platform reviewers (%s, %j)', async (scope, caps, visible) => {
  me.mockResolvedValue({ access_scope: { scope_type: scope }, capabilities: caps });
  expect(Boolean(findElement(await page(), 'create-form'))).toBe(visible);
});

test('existing resource queue and review footer remain reachable', async () => {
  const resource = findElement(await page(), 'resource-page');
  expect(resource.props.resourceKey).toBe('tenant_signup_requests');
  expect(resource.props.searchParams).toEqual({ status: 'pending' });
  expect(findElement(resource.props.renderDetailFooter({ detail: { status: 'pending' }, detailId: requestId }), 'review-form')).not.toBeNull();
});

test('server action verifies the session and submits only allowed request fields', async () => {
  const action = findElement(await page(), 'create-form').props.action;
  const result = await action({ status: 'idle' }, input());
  expect(verifySession).toHaveBeenCalledWith({ allowCookieSet: false });
  expect(rpc).toHaveBeenCalledWith('tenant_signup_request_create_reviewer_v1', {
    p_input: {
      email: 'person@example.com', full_name: 'Person', organization_name: 'Organization',
      organization_slug: 'prospect', website_url: null, phone: '+12025550123', notes: 'reviewer notes', locale: 'ar',
    },
  });
  expect(result.status).toBe('success');
  expect(result.requestHref).toContain(`id=${requestId}`);
  expect(result.requestHref).toContain('status=pending');
  expect(revalidatePath).toHaveBeenCalledWith('/organizations/requests');
});

test('actual shared UI RPC client passes the token from the same verified-session source into its server client', async () => {
  const createServerClient = jest.fn((options) => ({ options }));
  const { createUiServerClient } = loadComponent('packages/api/src/server.ts', {
    'server-only': {},
    react: { cache: (fn) => fn },
    '@masarx/auth/server': { getVerifiedAccessToken: verifySession, createServerClient },
    './rpc': { createRpc: () => async (fn, args) => fn === 'ui_me_v1' ? me() : rpc(fn, args) },
    './scope-normalize': { normalizeUiScopeType: (scope) => scope },
    './marketplace-client': { attachMarketplaceClient: () => ({}) },
    './settings-change-compat': {},
  });
  const { TenantSignupRequestsPage: ActualClientPage } = loadComponent('packages/ui/src/tenant-signup-requests-page.tsx', {
    ...pageImports, '@masarx/api/server': { createUiServerClient },
  });
  const tree = await ActualClientPage({ appKey: 'console', searchParams: {}, appBasePath: '', baseHref: '/organizations/requests', testIdPrefix: 'requests' });
  const result = await findElement(tree, 'create-form').props.action({ status: 'idle' }, input());
  expect(result.status).toBe('success');
  expect(verifySession.mock.calls.every(([options]) => options.allowCookieSet === false)).toBe(true);
  expect(createServerClient).toHaveBeenLastCalledWith({ allowCookieSet: false, accessToken: 'verified-session' });
  expect(rpc).toHaveBeenCalledWith('tenant_signup_request_create_reviewer_v1', expect.any(Object));
});

test.each([{ email: 'invalid' }, { full_name: ' ' }, { organization_name: '' }])('invalid required input cannot reach RPC: %j', async (invalid) => {
  const result = await findElement(await page(), 'create-form').props.action({ status: 'idle' }, input(invalid));
  expect(result.status).toBe('error');
  expect(rpc).not.toHaveBeenCalled();
});

test('direct invocation rechecks auth even when the page previously showed the form', async () => {
  const action = findElement(await page(), 'create-form').props.action;
  verifySession.mockResolvedValue({ accessToken: null, error: new Error('expired') });
  expect((await action({ status: 'idle' }, input())).status).toBe('error');
  expect(rpc).not.toHaveBeenCalled();
});

test('RPC authorization denial cannot become success or trigger revalidation', async () => {
  rpc.mockRejectedValue(new Error('reviewer_forbidden'));
  expect((await findElement(await page(), 'create-form').props.action({ status: 'idle' }, input())).status).toBe('error');
  expect(revalidatePath).not.toHaveBeenCalled();
});

test.each(['pending', 'approved', 'rejected'])('dedupe reports the actual existing %s status and links its readback', async (status) => {
  rpc.mockResolvedValue({ ok: true, id: requestId, status, deduped: true });
  const result = await findElement(await page(), 'create-form').props.action({ status: 'idle' }, input());
  expect(result.message).toBe(`Existing organization request reused (${status}).`);
  expect(result.requestHref).toContain(`status=${status}`);
});

test.each([
  { ok: false, error: { code: 'rate_limited' } },
  { ok: true, id: 'invalid', status: 'pending' },
  { ok: true, id: requestId, status: 'active' },
  { ok: true, id: requestId, status: 'approved' },
  null,
])('failed or malformed creation result cannot become success: %j', async (response) => {
  rpc.mockResolvedValue(response);
  const result = await findElement(await page(), 'create-form').props.action({ status: 'idle' }, input());
  expect(result.status).toBe('error');
  expect(result.requestHref).toBeUndefined();
  expect(revalidatePath).not.toHaveBeenCalled();
});

test.each([
  [{ status: 'idle' }, false],
  [{ status: 'error', message: 'rate_limited' }, false],
  [{ status: 'success', message: 'Queued', requestHref: '/organizations/requests?id=123' }, false],
  [{ status: 'idle' }, true],
])('form preserves semantic required fields and accessible result/pending states: %j/%s', (state, pending) => {
  const { TenantSignupRequestCreateForm } = loadComponent('packages/ui/src/tenant-signup-request-create-form.tsx', {
    react: { useActionState: () => [state, '/action', pending] },
    './input': { Input: 'input' }, './textarea': { Textarea: 'textarea' }, './button': { Button: 'button' },
  });
  const markup = renderToStaticMarkup(TenantSignupRequestCreateForm({ action: jest.fn(), testIdPrefix: 'create' }));
  for (const name of ['email', 'full_name', 'organization_name']) {
    expect(markup).toContain(`for="create-${name}"`);
    expect(markup).toContain(`id="create-${name}"`);
  }
  expect((markup.match(/required=""/g) || [])).toHaveLength(3);
  expect(markup).toContain('aria-live="polite"');
  expect(markup).not.toContain('name="created_by_user_id"');
  expect(markup).not.toContain('name="organization_id"');
  expect(markup).not.toContain('name="turnstile_verified"');
  expect(markup.includes('<fieldset disabled=""')).toBe(pending);
  if (state.message) expect(markup).toContain(state.message);
  expect(markup.includes('View organization request')).toBe(state.status === 'success');
});
