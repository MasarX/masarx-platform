const { mkdtempSync, readdirSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { checkInstallPolicy } = require('../../../scripts/ci-hosted/install-policy.cjs');
const { isPreviewOrigin, previewStatus } = require('../../../scripts/ci-hosted/dev-e2e-previews.cjs');
const DevE2EReporter = require('../../../scripts/ci-hosted/dev-e2e-reporter.cjs');

const root = resolve(__dirname, '../../..');
const workflowsDir = '.github/workflows';
const workflowPath = `${workflowsDir}/deploy.yml`;
const read = file => readFileSync(join(root, file), 'utf8');
const source = read(workflowPath);
const workflow = parse(source);
const job = workflow.jobs['e2e-report'];
const consoleOrigin = 'https://fixture-console-a1b2c3d4e-example-team.vercel.app';
const portalOrigin = 'https://fixture-portal-f5g6h7i8j-example-team.vercel.app';
const previews = [consoleOrigin, portalOrigin];

test('DEV browser report is non-blocking and depends on both deploy jobs on main', () => {
  expect(workflow.on.push).toEqual({ branches: ['main'] });
  expect(job.needs).toEqual(['console', 'portal']);
  expect(job['continue-on-error']).toBe(true);
  expect(job.if).toBe([
    "success() && github.ref == 'refs/heads/main' &&",
    "(github.event_name == 'push' || (github.event_name == 'workflow_dispatch' && inputs.mode == 'deploy'))",
  ].join(' '));
  expect(job.steps[0].with).toMatchObject({
    ref: '${{ github.sha }}',
    'persist-credentials': false,
  });
  expect(workflow.jobs.summary.needs).not.toContain('e2e-report');
});

test('DEV browser report uses a separate queue and reads only the deploy outputs', () => {
  expect(job.environment).toEqual({ name: 'dev', deployment: false });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(job.permissions).toBeUndefined();
  expect(job.concurrency).toEqual({ group: 'dev-e2e-report', queue: 'max', 'cancel-in-progress': false });
  const otherJobs = Object.values(workflow.jobs).filter(candidate => candidate !== job);
  expect(otherJobs.map(candidate => candidate.concurrency?.group)).not.toContain(job.concurrency.group);
  expect(JSON.stringify(job)).not.toMatch(/\bsecrets\s*(?:\.|\[)/);
  const env = {
    CONSOLE_BASE_URL: '${{ needs.console.outputs.preview_origin }}',
    PORTAL_BASE_URL: '${{ needs.portal.outputs.preview_origin }}',
  };
  expect(job.steps.find(step => step.id === 'previews')).toMatchObject({
    env, run: 'node scripts/ci-hosted/dev-e2e-previews.cjs probe',
  });
  expect(job.steps.find(step => step.run?.includes('playwright.dev-report.config.ts'))).toMatchObject({
    env: { ...env, E2E_REQUIRE_BASE_URLS: 'true' },
    run: expect.stringMatching(/> \/dev\/null 2>&1$/),
  });
  for (const name of job.needs) {
    expect(workflow.jobs[name].outputs.preview_origin).toBe('${{ steps.deploy.outputs.preview_origin }}');
    const deploy = workflow.jobs[name].steps.find(step => step.id === 'deploy');
    expect(deploy.run).toContain('deploy --prebuilt --yes');
    expect(deploy.run).not.toContain('--prod');
    expect(deploy.run).toContain('printf \'%s\' "$url" | node scripts/ci-hosted/dev-e2e-previews.cjs capture');
  }
});

test('workflows avoid DEV base URL variables and checkout of a workflow_run head', () => {
  const files = readdirSync(join(root, workflowsDir)).filter(name => /\.ya?ml$/i.test(name));
  expect(files).not.toContain('dev-e2e-report.yml');
  for (const file of files) {
    const text = read(join(workflowsDir, file));
    expect(text).not.toMatch(/\bvars\s*(?:\.\s*|\[\s*['"])(?:CONSOLE|PORTAL)_BASE_URL\b/i);
    const candidate = parse(text);
    const triggers = typeof candidate.on === 'string' ? [candidate.on] :
      Array.isArray(candidate.on) ? candidate.on : Object.keys(candidate.on ?? {});
    if (!triggers.includes('workflow_run')) continue;
    for (const step of Object.values(candidate.jobs).flatMap(candidateJob => candidateJob.steps ?? [])) {
      if (!step.uses?.startsWith('actions/checkout@')) continue;
      const ref = String(step.with?.ref ?? '').replace(/\[\s*['"](\w+)['"]\s*\]/g, '.$1').replace(/\s/g, '');
      expect({ file, ref }).toEqual({ file, ref: expect.not.stringMatching(/\bworkflow_run\.head_(?:sha|branch)\b/i) });
    }
  }
});

test('preview guard accepts only generated HTTPS Vercel deployment origins', async () => {
  expect(previews.every(isPreviewOrigin)).toBe(true);
  const rejected = [
    'https://fixture-console.example.test',
    'https://fixture-console.vercel.app',
    'https://fixture-console-git-dev-example-team.vercel.app',
    '', `${consoleOrigin}/`, `${consoleOrigin}/login`, `${consoleOrigin}:443`, `${consoleOrigin}:444`,
    `${consoleOrigin}?target=fixture`, `${consoleOrigin}#fixture`, `${consoleOrigin}\n`,
    `${consoleOrigin}.example.test`, consoleOrigin.replace('https:', 'http:'),
  ];
  const request = jest.fn();
  for (const origin of rejected) {
    expect(isPreviewOrigin(origin)).toBe(false);
    await expect(previewStatus([consoleOrigin, origin], request)).resolves.toBe('preview_unavailable');
  }
  expect(request).not.toHaveBeenCalled();
});

test.each([401, 403])('preview probe recognizes a Vercel authentication page with HTTP %i', async status => {
  const request = jest.fn(async origin => origin === consoleOrigin
    ? new Response('<title>Authentication Required</title>Vercel Authentication', { status })
    : new Response('app'));
  await expect(previewStatus(previews, request)).resolves.toBe('preview_protected');
});

test('preview probe reads login redirects without following them', async () => {
  const request = jest.fn(async origin => origin === portalOrigin
    ? Response.redirect('https://vercel.com/login?next=%2F')
    : Response.redirect(`${consoleOrigin}/login`));
  await expect(previewStatus(previews, request)).resolves.toBe('preview_protected');
  expect(request.mock.calls.map(([origin, options]) => [origin, options.redirect])).toEqual([
    [consoleOrigin, 'manual'], [portalOrigin, 'manual'],
  ]);
});

test('preview probe leaves unrelated app responses for the anonymous specs', async () => {
  await expect(previewStatus(previews, async origin => origin === consoleOrigin
    ? Response.redirect(`${consoleOrigin}/login`)
    : new Response('app forbidden', { status: 403, headers: { server: 'Vercel' } }))).resolves.toBe('ready');
  await expect(previewStatus(previews, async () => Response.redirect('https://vercel.com.example.test/login')))
    .resolves.toBe('preview_unavailable');
  await expect(previewStatus(previews, async () => { throw new Error('fixture request failed'); }))
    .resolves.toBe('preview_unreachable');
});

test('DEV browser report uses the locked install policy and uploads only the redacted report', () => {
  expect(workflow.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
  expect(job.steps).toContainEqual({
    name: 'Install locked dependencies',
    if: "steps.previews.outputs.ready == 'true'",
    run: 'node scripts/ci-hosted/tasks.cjs install',
  });
  for (const step of job.steps.slice(3, 6)) expect(step.if).toBe("steps.previews.outputs.ready == 'true'");
  expect(job.steps.find(step => step.id === 'report').if)
    .toBe("${{ !cancelled() && (steps.previews.outputs.ready == 'true' || steps.previews.outcome == 'skipped') }}");
  expect(checkInstallPolicy(new Map([[workflowPath, source]]))).toEqual([]);
  const actions = job.steps.filter(step => step.uses);
  expect(actions.map(step => step.uses)).toEqual([
    expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
    expect.stringMatching(/^actions\/setup-node@[a-f0-9]{40}$/),
    expect.stringMatching(/^actions\/upload-artifact@[a-f0-9]{40}$/),
  ]);
  expect(actions[1].with).toEqual({ 'node-version-file': '.nvmrc', 'package-manager-cache': false });
  expect(actions[2].if).toBe("${{ !cancelled() && steps.report.outcome == 'success' }}");
  expect(actions[2].with).toEqual({
    name: 'dev-e2e-playwright-report',
    path: '${{ runner.temp }}/dev-e2e-report.json',
    'if-no-files-found': 'error',
    'retention-days': 1,
  });
  expect(read('playwright.dev-report.config.ts')).toContain('use: { trace: "off", screenshot: "off", video: "off" }');
});

test('DEV Playwright report projects counts and spec names without runtime test data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dev-e2e-report-'));
  const reportPath = join(dir, 'report.json');
  const summaryPath = join(dir, 'summary.md');
  const consoleSpec = 'console-public-auth.spec.ts';
  const portalSpec = 'portal-public-auth.spec.ts';
  const privateData = `private-test-value-${dir.length}`;
  const result = status => ({
    location: { file: join(dir, 'shared-helper.ts') },
    title: privateData,
    results: status ? [{ status, errors: [privateData], stdout: [privateData], attachments: [privateData] }] : [],
  });
  const suite = files => ({ suites: [{ suites: files.map(([spec, ...statuses]) => ({
    location: { file: join(dir, privateData, spec) },
    allTests: () => statuses.map(result),
  })) }] });

  try {
    const reporter = new DevE2EReporter({ specs: [consoleSpec, portalSpec], reportPath, summaryPath });
    reporter.onBegin({}, suite([
      [consoleSpec, 'passed', 'skipped'],
      [portalSpec, 'timedOut', undefined],
      [`${privateData}.spec.ts`, 'failed'],
    ]));
    expect(reporter.onEnd({ status: 'failed' })).toEqual({ status: 'failed' });
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toEqual({
      status: 'failed',
      specs: [
        { spec: consoleSpec, passed: 1, failed: 0, skipped: 1, incomplete: 0 },
        { spec: portalSpec, passed: 0, failed: 1, skipped: 0, incomplete: 1 },
      ],
      failedSpecs: [portalSpec],
    });
    const summary = readFileSync(summaryPath, 'utf8');
    expect(summary).toContain(`| \`${consoleSpec}\` | 1 | 0 | 1 | 0 |`);
    expect(summary).toContain(`| \`${portalSpec}\` | 0 | 1 | 0 | 1 |`);
    expect(summary).toContain(`Failed specs: \`${portalSpec}\``);
    expect(summary).not.toContain(privateData);

    const partial = new DevE2EReporter({ specs: [consoleSpec, portalSpec], reportPath, summaryPath });
    partial.onBegin({}, suite([[consoleSpec, 'passed']]));
    expect(partial.onEnd({ status: 'passed' })).toEqual({ status: 'failed' });
    expect(readFileSync(summaryPath, 'utf8')).toContain(`Specs without collected tests: \`${portalSpec}\``);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
