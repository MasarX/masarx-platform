const formType = () => null;
const mockFetch = jest.fn();
const exported = {};
let React;
beforeAll(async () => {
  const [fs, path, vm, tsModule, react, jsx] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:vm'), import('typescript'), import('react'), import('react/jsx-runtime'),
  ]);
  React = react;
  const ts = tsModule.default;
  const compiled = ts.transpileModule(fs.readFileSync(path.resolve(__dirname,
    '../../../../packages/ui/src/marketplace-participant-requests-page.tsx'), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX },
  }).outputText;
  vm.runInNewContext(`(function(require,exports){${compiled}\n})`, { process, URL, FormData, Set, fetch })(specifier => {
    const modules = {
      'server-only': {}, 'react/jsx-runtime': jsx,
      '@masarx/api/server': { createUiServerClient: () => ({ me: async () => ({ capabilities: [] }) }) },
      '@masarx/auth/server': { getVerifiedAccessToken: async () => ({ accessToken: 'owned-reviewer' }),
        createServerReachableFetch: () => mockFetch },
      '@masarx/config': { getPublicConfig: () => ({ supabaseUrl: 'https://db.example.test' }) },
      './resource-page': { ResourcePage: () => null }, './section': { Section: () => null }, './badge': { Badge: () => null },
      './marketplace-participant-review-form': { MarketplaceParticipantReviewForm: formType },
      './utils': { formatUiError: (_error, fallback) => fallback },
      './capabilities': { hasCapability: () => true, resolveCapabilitySet: () => [] },
    };
    if (!(specifier in modules)) throw new Error(`Unexpected import: ${specifier}`);
    return modules[specifier];
  }, exported);
});

function findForm(node) {
  if (!React.isValidElement(node)) return undefined;
  if (node.type === formType) return node;
  return React.Children.toArray(node.props.children).map(findForm).find(Boolean);
}

async function reviewForm(detail = {}) {
  const page = await exported.MarketplaceParticipantRequestsPage({ appKey: 'console', searchParams: {},
    appBasePath: '/console', baseHref: '/console/marketplace/reviews', testIdPrefix: 'reviews' });
  const footer = page.props.renderDetailFooter({ detail: { status: 'pending', ...detail }, detailError: null,
    detailId: '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830' });
  const form = findForm(footer);
  if (!form) throw new Error('Review form missing');
  return { form, footer };
}

function payload(decision = 'request_additional_docs', requestedDocuments = ' license \nidentity\nlicense ') {
  const data = new FormData();
  data.set('request_id', '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830');
  data.set('decision', decision); data.set('reason', 'Please replace the license');
  data.set('requested_documents', requestedDocuments);
  return data;
}

const pendingResult = { ok: true, decision: 'request_additional_docs', result: {
  ok: true, status: 'pending', decision: 'request_additional_docs', decision_log_id: 'decision', domain_event_id: 'event',
} };
beforeEach(() => { mockFetch.mockReset(); mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => pendingResult }); });

test('form action normalizes document types and waits for canonical pending readback', async () => {
  const { form } = await reviewForm();
  expect(await form.props.action({}, payload('request-docs'))).toMatchObject({ status: 'success', message: expect.stringContaining('remains pending') });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toMatchObject({ decision: 'request_additional_docs',
    reason: 'Please replace the license', metadata: { requested_documents: ['license', 'identity'] } });
  expect(mockFetch.mock.calls[0][1].headers.authorization).toBe('Bearer owned-reviewer');
});

test.each([null, {}, { ok: true }, { ok: true, result: { ok: true, status: 'approved' } },
  { ok: true, result: { ok: false, status: 'pending', decision: 'request_additional_docs' } }])('malformed readback %j is not a success', async result => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => result });
  const { form } = await reviewForm();
  expect((await form.props.action({}, payload())).status).toBe('error');
});

test('oversized document type is rejected before the API call', async () => {
  const { form } = await reviewForm();
  expect((await form.props.action({}, payload('request_docs', 'x'.repeat(101)))).status).toBe('error');
  expect(mockFetch).not.toHaveBeenCalled();
});

test('safe pending projection remains reviewable and completed decisions are not shadowed by stale metadata', async () => {
  const metadata = { decision: 'request_additional_docs', requested_documents: ['private-internal-type'] };
  const pending = await reviewForm({ review_decision: 'request_additional_docs', requested_documents: ['license', 'identity'], review_reason: 'Replace license' });
  expect(pending.form.props.disabled).toBe(false);
  const pendingText = JSON.stringify(pending.footer);
  expect(pendingText).toContain('Requested documents'); expect(pendingText).toContain('license');
  expect(pendingText).toContain('Replace license');
  expect(pendingText).not.toContain('decision_metadata');
  const completed = await reviewForm({ status: 'approved', review_decision: 'approved', requested_documents: ['license'], decision_metadata: metadata });
  expect(completed.form.props.disabled).toBe(true);
  expect(JSON.stringify(completed.footer)).not.toContain('Requested documents');
});

test.each(['approved', 'rejected'])('%s keeps its existing result message without document metadata', async decision => {
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
  const { form } = await reviewForm();
  expect(await form.props.action({}, payload(decision))).toMatchObject({ status: 'success', message: expect.stringContaining(decision) });
  expect(JSON.parse(mockFetch.mock.calls[0][1].body).metadata.requested_documents).toBeUndefined();
});
