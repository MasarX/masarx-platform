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
      'public-intake-service-role',
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
