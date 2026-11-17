const path = require('path');

const {
  buildStaticFindings,
  buildWorkflowBarrierFinding,
  deriveDecision,
  resolveEvidenceDir,
} = require('../../../scripts/ops/audit/stg-go-live-security-review');

describe('stg-go-live-security-review', () => {
  const repoRoot = path.join(process.cwd(), 'repo-root-fixture');

  test('resolveEvidenceDir uses the configured bucket and UTC date by default', () => {
    const evidenceDir = resolveEvidenceDir(
      {
        repoRoot,
        evidenceDate: '',
        evidenceDir: '',
      },
      { bucket: 'stg-go-live-security-review' },
      '2026-03-05T16:40:00.000Z',
    );

    expect(evidenceDir).toBe(
      path.join(repoRoot, 'docs', 'ops', 'evidence', '2026-03-05', 'stg-go-live-security-review'),
    );
  });

  test('buildStaticFindings detects the staged web and public-intake issues', () => {
    const fileMap = {
      'apps/shared/security-headers.js': {
        filePath: path.join(repoRoot, 'apps', 'shared', 'security-headers.js'),
        content: `const scriptSources = ["'self'", "'unsafe-inline'"];\n`,
      },
      'apps/shared/ui-event-route.ts': {
        filePath: path.join(repoRoot, 'apps', 'shared', 'ui-event-route.ts'),
        content: [
          'const supabase = createServerClient({ allowCookieSet: false });',
          'const { data, error: sessionError } = await supabase.auth.getSession();',
          'const text = await request.text();',
        ].join('\n'),
      },
      'apps/shared/app-layout.tsx': {
        filePath: path.join(repoRoot, 'apps', 'shared', 'app-layout.tsx'),
        content: 'const { data } = await authClient.auth.getSession();\n',
      },
      'apps/console/app/auth/sign-out/route.ts': {
        filePath: path.join(repoRoot, 'apps', 'console', 'app', 'auth', 'sign-out', 'route.ts'),
        content: 'export async function GET(request: Request) {\n',
      },
      'apps/console/app/api/resource-download/route.ts': {
        filePath: path.join(repoRoot, 'apps', 'console', 'app', 'api', 'resource-download', 'route.ts'),
        content: [
          'export async function GET(request: NextRequest) {',
          'const supabase = createServerClient();',
          'const { data, error } = await supabase.auth.getSession();',
          'return redirectWithRequestId(result.url, requestId, 302);',
        ].join('\n'),
      },
      'apps/portal/app/api/resource-download/route.ts': {
        filePath: path.join(repoRoot, 'apps', 'portal', 'app', 'api', 'resource-download', 'route.ts'),
        content: [
          'export async function GET(request: NextRequest) {',
          'const supabase = createServerClient();',
          'const { data, error } = await supabase.auth.getSession();',
          'return redirectWithRequestId(result.url, requestId, 302);',
        ].join('\n'),
      },
      'apps/portal/app/auth/sign-out/route.ts': {
        filePath: path.join(repoRoot, 'apps', 'portal', 'app', 'auth', 'sign-out', 'route.ts'),
        content: 'export async function GET(request: Request) {\n',
      },
      'packages/auth/src/next.ts': {
        filePath: path.join(repoRoot, 'packages', 'auth', 'src', 'next.ts'),
        content: 'export async function handleSignOut(request: Request) {\n',
      },
      'packages/ui/src/dashboard-page.tsx': {
        filePath: path.join(repoRoot, 'packages', 'ui', 'src', 'dashboard-page.tsx'),
        content: 'const { data } = await authClient.auth.getSession();\n',
      },
      'packages/ui/src/route-operations-workspace-page.tsx': {
        filePath: path.join(repoRoot, 'packages', 'ui', 'src', 'route-operations-workspace-page.tsx'),
        content: 'const { data } = await authClient.auth.getSession();\n',
      },
      'packages/ui/src/tenant-signup-requests-page.tsx': {
        filePath: path.join(repoRoot, 'packages', 'ui', 'src', 'tenant-signup-requests-page.tsx'),
        content: 'const { data: sessionData, error: sessionError } = await authClient.auth.getSession();\n',
      },
      'supabase/functions/marketing-lead-intake/index.ts': {
        filePath: path.join(repoRoot, 'supabase', 'functions', 'marketing-lead-intake', 'index.ts'),
        content: '} else if (SUPABASE_SERVICE_KEY) {\n',
      },
      'supabase/functions/tenant-signup-intake/index.ts': {
        filePath: path.join(repoRoot, 'supabase', 'functions', 'tenant-signup-intake', 'index.ts'),
        content: 'return createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {\n',
      },
    };

    const findings = buildStaticFindings({ repoRoot, fileMap });
    const findingIds = findings.map((entry) => entry.id).sort();

    expect(findingIds).toEqual([
      'public-intake-marketing-lead-intake-coverage',
      'public-intake-tenant-signup-intake-coverage',
      'server-auth-getsession',
      'web-csp-unsafe-inline',
      'web-download-get-csrf',
      'web-signout-get',
      'web-ui-event-csrf',
    ]);
  });

  test('buildWorkflowBarrierFinding produces a P0 finding when mandatory workflows are incomplete', () => {
    const finding = buildWorkflowBarrierFinding([
      {
        id: 'verify_ui_stg',
        label: 'Verify UI (Stg)',
        conclusion: 'blocked',
        reason: 'gh auth status failed',
      },
    ]);

    expect(finding).toMatchObject({
      id: 'workflow-evidence-incomplete',
      severity: 'P0',
      surface: 'ci_cd',
      status: 'confirmed',
    });
    expect(finding.evidence[0]).toContain('Verify UI (Stg)');
  });

  test('deriveDecision returns NO-GO when P0 findings or workflow failures remain', () => {
    const decision = deriveDecision({
      findings: [
        { id: 'workflow-evidence-incomplete', severity: 'P0' },
        { id: 'web-csp-unsafe-inline', severity: 'P1' },
      ],
      workflowResults: [
        { id: 'verify_ui_stg', conclusion: 'blocked' },
      ],
      commandResults: [
        { id: 'security_scan_gate', ok: true },
      ],
    });

    expect(decision.recommendation).toBe('NO-GO');
    expect(decision.counts.P0).toBe(1);
    expect(decision.rationale).toContain('P0 findings open: 1');
  });
});

describe('public intake source-call contract independence', () => {
  const root = process.cwd();
  const marketing = `
    const invokeRpcWithAuthFallback = () => {};
    invokeRpcWithAuthFallback("marketing_landing_clients_list_v1", {});
    invokeRpcWithAuthFallback("marketing_lead_request_create_v1", {}, { serviceOnly: true });
  `;
  const tenant = 'serviceClient.rpc("tenant_signup_request_create_v1", {});';
  const findingsFor = (m = marketing, t = tenant) => buildStaticFindings({
    repoRoot: root,
    fileMap: Object.fromEntries([
      ['marketing-lead-intake', m], ['tenant-signup-intake', t],
    ].filter(([, content]) => content !== null).map(([endpoint, content]) => {
      const relative = `supabase/functions/${endpoint}/index.ts`;
      return [relative, { filePath: path.join(root, relative), content }];
    })),
  }).filter((finding) => finding.id.startsWith('public-intake-'));

  test.each([
    [false, false, []],
    [true, false, ['public-intake-marketing-lead-intake-contract']],
    [false, true, ['public-intake-tenant-signup-intake-contract']],
    [true, true, ['public-intake-marketing-lead-intake-contract', 'public-intake-tenant-signup-intake-contract']],
  ])('independent violation matrix marketing=%s tenant=%s', (badM, badT, expected) => {
    const m = badM ? marketing.replace('serviceOnly: true', 'serviceOnly: false') : marketing;
    const t = badT ? tenant + ' serviceClient.from("other_table");' : tenant;
    expect(findingsFor(m, t).map((finding) => finding.id)).toEqual(expected);
  });

  test.each(['sb_secret_fixture', 'header.payload.signature'])(
    'approved credential shape alone is not a violation: %s', (credential) => {
      const declaration = `const serviceKey = "${credential}";\n`;
      expect(findingsFor(declaration + marketing, declaration + tenant)).toEqual([]);
    },
  );

  test.each([
    ['missing marketing', null, tenant, 'marketing-lead-intake'],
    ['missing tenant', marketing, null, 'tenant-signup-intake'],
    ['parse failure', 'const =', tenant, 'marketing-lead-intake'],
    ['dynamic mutation', marketing.replace('"marketing_lead_request_create_v1"', 'rpcName'), tenant, 'marketing-lead-intake'],
    ['helper alias', marketing + ' const alias = invokeRpcWithAuthFallback;', tenant, 'marketing-lead-intake'],
    ['computed call', marketing, tenant + ' serviceClient[method]("x");', 'tenant-signup-intake'],
    ['unknown auth options', marketing.replace('{ serviceOnly: true }', 'options'), tenant, 'marketing-lead-intake'],
  ])('%s stays explicit incomplete coverage', (_label, m, t, endpoint) => {
    const result = findingsFor(m, t);
    expect(result.some((finding) => finding.id === `public-intake-${endpoint}-coverage`
      && finding.status === 'unverified')).toBe(true);
    expect(deriveDecision({ findings: result, workflowResults: [], commandResults: [] })
      .recommendation).toBe('GO WITH EXCEPTIONS');
  });

  test('missing endpoint never hides a violation in the other endpoint', () => {
    expect(findingsFor(null, tenant + ' serviceClient.from("other");')
      .map((finding) => finding.id)).toEqual([
      'public-intake-marketing-lead-intake-coverage',
      'public-intake-tenant-signup-intake-contract',
    ]);
  });

  test('comments and string contents are not executable RPC calls', () => {
    expect(findingsFor(marketing + '\n// client.from("other");\nconst text = "client.rpc(name)";', tenant)).toEqual([]);
  });

  test('unexpected literal RPC is a contract finding even when approved calls remain', () => {
    expect(findingsFor(marketing, tenant + ' serviceClient.rpc("other_mutation", {});')
      .map((finding) => finding.id)).toEqual(['public-intake-tenant-signup-intake-contract']);
  });
  test('Array.from is not a database operation; unknown receivers are coverage only', () => {
    expect(findingsFor(marketing + ' Array.from(bytes);', tenant)).toEqual([]);
    const result = findingsFor(marketing, tenant + ' unknownClient.from("rows");');
    expect(result.map((finding) => finding.id)).toEqual(['public-intake-tenant-signup-intake-coverage']);
  });

  test('actual current endpoint sources retain supported source-call coverage', () => {
    const fs = require('fs');
    const currentMarketing = fs.readFileSync(path.join(root, 'supabase/functions/marketing-lead-intake/index.ts'), 'utf8');
    const currentTenant = fs.readFileSync(path.join(root, 'supabase/functions/tenant-signup-intake/index.ts'), 'utf8');
    expect(findingsFor(currentMarketing, currentTenant)).toEqual([]);
    expect(findingsFor(currentMarketing.replace('{ serviceOnly: true }', '{ serviceOnly: false }'), currentTenant)
      .some((finding) => finding.id === 'public-intake-marketing-lead-intake-contract')).toBe(true);
  });

  test('missing parser reports both endpoint coverage gaps without installation', () => {
    jest.isolateModules(() => {
      jest.doMock('typescript', () => { throw new Error('parser unavailable'); });
      try {
        const isolated = require('../../../scripts/ops/audit/stg-go-live-security-review');
        const result = isolated.buildStaticFindings({ repoRoot: root, fileMap: {} });
        const coverage = result.filter((finding) => finding.id.startsWith('public-intake-'));
        expect(coverage).toHaveLength(2);
        expect(coverage.every((finding) => finding.evidence.some((reason) => reason.includes('parser is unavailable')))).toBe(true);
      } finally {
        jest.dontMock('typescript');
      }
    });
  });

});
