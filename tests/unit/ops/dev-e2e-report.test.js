const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { parse } = require('yaml');
const { checkInstallPolicy } = require('../../../scripts/ci-hosted/install-policy.cjs');
const DevE2EReporter = require('../../../scripts/ci-hosted/dev-e2e-reporter.cjs');

const root = resolve(__dirname, '../../..');
const workflowPath = '.github/workflows/dev-e2e-report.yml';
const read = file => readFileSync(join(root, file), 'utf8');
const source = read(workflowPath);
const workflow = parse(source);
const deploy = parse(read('.github/workflows/deploy.yml'));
const job = workflow.jobs['dev-e2e-report'];

test('DEV browser report admits successful main deploy pushes and main manual dispatch only', () => {
  expect(workflow.on).toEqual({
    workflow_run: { workflows: [deploy.name], types: ['completed'], branches: ['main'] },
    workflow_dispatch: null,
  });
  expect(job.if).toBe([
    "github.ref == 'refs/heads/main' &&",
    "(github.event_name == 'workflow_dispatch' ||",
    "(github.event_name == 'workflow_run' &&",
    "github.event.workflow_run.event == 'push' &&",
    "github.event.workflow_run.head_branch == 'main' &&",
    'github.event.workflow_run.head_repository.full_name == github.repository &&',
    "github.event.workflow_run.conclusion == 'success'))",
  ].join(' '));
  expect(job.steps[0].with).toMatchObject({
    ref: '${{ github.event.workflow_run.head_sha || github.sha }}',
    'persist-credentials': false,
  });
});

test('DEV browser report uses DEV variables and a separate queue with read-only access', () => {
  expect(job.environment).toEqual({ name: 'dev', deployment: false });
  expect(workflow.permissions).toEqual({ contents: 'read' });
  expect(job.permissions).toBeUndefined();
  expect(job.concurrency).toEqual({ group: 'dev-e2e-report', queue: 'max', 'cancel-in-progress': false });
  expect(Object.values(deploy.jobs).map(job => job.concurrency?.group)).not.toContain(job.concurrency.group);
  expect(source).not.toMatch(/\bsecrets\s*(?:\.|\[)/);
  expect(job.steps.find(step => step.run?.includes('playwright.dev-report.config.ts'))).toMatchObject({
    env: {
      CONSOLE_BASE_URL: '${{ vars.CONSOLE_BASE_URL }}',
      PORTAL_BASE_URL: '${{ vars.PORTAL_BASE_URL }}',
      E2E_REQUIRE_BASE_URLS: 'true',
    },
    run: expect.stringMatching(/> \/dev\/null 2>&1$/),
  });
});

test('DEV browser report uses the locked install policy and uploads only the redacted report', () => {
  expect(workflow.env.NPM_CONFIG_IGNORE_SCRIPTS).toBe('true');
  expect(job.steps).toContainEqual({
    name: 'Install locked dependencies', run: 'node scripts/ci-hosted/tasks.cjs install',
  });
  expect(checkInstallPolicy(new Map([[workflowPath, source]]))).toEqual([]);
  const actions = job.steps.filter(step => step.uses);
  expect(actions.map(step => step.uses)).toEqual([
    expect.stringMatching(/^actions\/checkout@[a-f0-9]{40}$/),
    expect.stringMatching(/^actions\/setup-node@[a-f0-9]{40}$/),
    expect.stringMatching(/^actions\/upload-artifact@[a-f0-9]{40}$/),
  ]);
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
