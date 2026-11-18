const requestId = '4d1fbd36-6b6e-4c35-acc4-5e3ad9043830';
const reviewerId = '22222222-2222-4222-8222-222222222222';
let vm;
let compiled;
let reviewFixture;
let scopeContract;
beforeAll(async () => {
  const [fs, path, vmModule, tsModule] = await Promise.all([
    import('node:fs'), import('node:path'), import('node:vm'), import('typescript'),
  ]);
  vm = vmModule;
  const ts = tsModule.default;
  const source = fs.readFileSync(path.resolve(__dirname,
    '../../../supabase/functions/marketplace-participant-review/index.ts'), 'utf8');
  reviewFixture = fs.readFileSync(path.resolve(__dirname,
    '../../integration/edge/marketplace-participant-review-e2e.test.js'), 'utf8');
  scopeContract = fs.readFileSync(path.resolve(__dirname,
    '../../../supabase/migrations/202601240320_lookup_contracts_replace_literal_enum_checks.sql'), 'utf8');
  compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
  }).outputText;
});

function load(options = {}) {
  let handler;
  const userRpc = jest.fn(async () => options.denied
    ? { error: { message: 'platform_scope_required' } }
    : { data: { user_id: reviewerId } });
  const serviceRpc = jest.fn(async () => options.rpcResult || { data: {
    ok: true, status: 'pending', decision: 'request_additional_docs',
    decision_log_id: 'decision-log', domain_event_id: 'event',
  } });
  const approve = jest.fn(async () => ({ ok: true, status: 'approved' }));
  const createClient = jest.fn((_url, _key, config) => ({
    rpc: config.global.headers.Authorization ? userRpc : serviceRpc,
  }));
  const shared = {
    extractToken: req => req.headers.get('authorization')?.replace(/^Bearer /, '') || '',
    parseRequestBody: async req => ({ json: await req.json() }),
    readEnv: key => ({ EDGE_SUPABASE_URL: 'https://db.example.test',
      EDGE_SUPABASE_ANON_KEY: 'synthetic-anon', EDGE_SUPABASE_SECRET_KEY: 'sb_secret_fixture' })[key] || '',
  };
  const signup = {
    asString: value => typeof value === 'string' ? value.trim() : '',
    approveMarketplaceParticipantRequest: approve,
    loadMarketplaceCompliancePolicy: async () => ({ approval_mode: 'required' }),
  };
  vm.runInNewContext(`(function(require,exports){${compiled}\n})`, {
    Request, Response, Set, Deno: { serve: fn => { handler = fn; } },
  })(specifier => {
    if (specifier.startsWith('npm:')) return { createClient };
    if (specifier === './_shared/mod.mjs') return shared;
    if (specifier === './_shared/marketplace_signup.ts') return signup;
    throw new Error(`Unexpected import: ${specifier}`);
  }, {});
  return { userRpc, serviceRpc, approve, createClient,
    send: (payload, token = 'synthetic-reviewer') => handler(new Request('https://edge.example.test/review', {
      method: 'POST', headers: { 'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(payload),
    })),
  };
}

describe('marketplace participant review request-documents handler', () => {
  test('review fixtures retain distinct real operators with canonical null platform and tenant scope IDs', () => {
    expect(scopeContract).toMatch(/jsonb_build_object\('requires_scope_id', false\)[\s\S]*?lv\.value IN \('platform', 'tenant'\)/);
    expect(scopeContract).toMatch(/\(access_scope_id IS NOT NULL\) =\s*public\.lookup_value_meta_bool\('access_scope_type', access_scope_type, 'requires_scope_id', false\)/);
    const actors = [...reviewFixture.matchAll(/INSERT INTO users\s*\([\s\S]*?\)\s*VALUES\s*\(([\s\S]*?)\)/g)]
      .map((match) => match[1].split(',').map((value) => value.trim()));
    expect(actors).toHaveLength(2);
    expect(actors.map((values) => values.slice(-4))).toEqual([
      ["'ops_admin'", "'active'", "'platform'", 'NULL'],
      ["'ops_admin'", "'active'", "'tenant'", 'NULL'],
    ]);
    expect(reviewFixture).toContain('expect(denied.status).toBe(403)');
  });

  test.each(['request_additional_docs', 'request-docs', 'request_docs', 'additional_docs'])('%s reaches the existing pending review RPC', async decision => {
    const app = load();
    const response = await app.send({ request_id: requestId, decision, reason: 'Please replace the license',
      metadata: { requested_documents: [' license ', 'identity', 'license'], source: 'owned-test' } });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, decision: 'request_additional_docs',
      result: { ok: true, status: 'pending', decision_log_id: 'decision-log', domain_event_id: 'event' } });
    expect(app.userRpc).toHaveBeenCalledWith('marketplace_assert_reviewer_v1');
    expect(app.serviceRpc).toHaveBeenCalledWith('marketplace_participant_request_review_apply_v1', {
      p_request_id: requestId, p_decision: 'request_additional_docs', p_reviewer_user_id: reviewerId,
      p_invited_auth_user_id: null, p_invite_email_sent: false, p_invite_redirect_to: null,
      p_approved_organization_id: null, p_approved_user_id: null,
      p_decision_metadata: { source: 'owned-test', requested_documents: ['license', 'identity'],
        reason: 'Please replace the license', reviewed_via: 'marketplace-participant-review',
        approval_mode: 'required', request_additional_docs: true },
    });
    expect(app.approve).not.toHaveBeenCalled();
  });

  test('preserves optional reason/documents and the donor note alias', async () => {
    const app = load();
    expect((await app.send({ request_id: requestId, decision: 'request_docs' })).status).toBe(200);
    expect(app.serviceRpc.mock.calls[0][1].p_decision_metadata.reason).toBeNull();
    expect(app.serviceRpc.mock.calls[0][1].p_decision_metadata.requested_documents).toBeUndefined();
    await app.send({ request_id: requestId, decision: 'request_docs', metadata: { note: 'canonical note' } });
    expect(app.serviceRpc.mock.calls[1][1].p_decision_metadata.reason).toBe('canonical note');
  });

  test.each(['license', {}, [1], [''], ['  '], ['x'.repeat(101)]])('invalid supplied documents %j never mutate', async requested_documents => {
    const app = load();
    expect((await app.send({ request_id: requestId, decision: 'request_docs', metadata: { requested_documents } })).status).toBe(400);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('missing authentication and tenant-scoped reviewers cannot mutate', async () => {
    const anonymous = load();
    expect((await anonymous.send({ request_id: requestId, decision: 'request_docs' }, null)).status).toBe(401);
    expect(anonymous.createClient).not.toHaveBeenCalled();
    const denied = load({ denied: true });
    const response = await denied.send({ request_id: requestId, decision: 'request_docs' });
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'reviewer_forbidden' } });
    expect(denied.serviceRpc).not.toHaveBeenCalled();
  });

  test.each([{ data: { ok: false, error: { code: 'request_not_found' } } },
    { error: { message: 'sql failed' } }, { data: null }])('does not invent success on RPC rejection %j', async rpcResult => {
    const app = load({ rpcResult });
    const response = await app.send({ request_id: requestId, decision: 'request_docs' });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ ok: false, error: { code: 'request_additional_docs_failed' } });
  });

  test('unknown actions fail before client construction', async () => {
    const app = load();
    expect((await app.send({ request_id: requestId, decision: 'delete' })).status).toBe(400);
    expect(app.createClient).not.toHaveBeenCalled();
  });

  test('approve and reject keep their canonical dispatch and do not carry document requests', async () => {
    const app = load({ rpcResult: { data: { ok: true, status: 'rejected' } } });
    expect((await app.send({ request_id: requestId, decision: 'approve', reason: 'accepted' })).status).toBe(200);
    expect(app.approve).toHaveBeenCalledWith(expect.objectContaining({ requestId, reviewerUserId: reviewerId, decisionReason: 'accepted' }));
    expect((await app.send({ request_id: requestId, decision: 'reject', reason: 'denied' })).status).toBe(200);
    expect(app.serviceRpc.mock.calls[0][1].p_decision).toBe('rejected');
    expect(app.serviceRpc.mock.calls[0][1].p_decision_metadata.request_additional_docs).toBeUndefined();
    expect(app.serviceRpc.mock.calls[0][1].p_decision_metadata.requested_documents).toBeUndefined();
  });
});
