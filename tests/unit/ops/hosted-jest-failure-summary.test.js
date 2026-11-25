const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawnSync } = require('node:child_process');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const scripts = path.join(root, 'scripts/ci-hosted');
const { identity } = require(path.join(scripts, 'jest.cjs'));

test('the unit and UI jobs bind the reporter to the uploaded Jest result', () => {
  const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/public-ci.yml'), 'utf8'));
  for (const lane of ['unit', 'ui']) {
    const job = workflow.jobs[lane];
    const upload = job.steps.findIndex(step => step.id === 'jest_report');
    const report = job.steps[upload + 1];
    expect(upload).toBeGreaterThanOrEqual(0);
    expect(job.steps[upload].uses).toMatch(/^actions\/upload-artifact@/);
    expect(job.env.HOSTED_JEST_LANE).toBe(lane);
    expect(report.if).toBe('${{ always() && !cancelled() }}');
    expect(report.env.JEST_ARTIFACT_URL).toBe('${{ steps.jest_report.outputs.artifact-url }}');
    expect(report.run).toBe('node scripts/ci-hosted/jest-failure-summary.cjs "$HOSTED_JEST_LANE"');
  }
});

test('a controlled Jest failure retains its verdict and complete artifact while the summary is bounded', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-jest-summary-'));
  try {
    const file = 'tests/unit/example.test.js';
    const secret = randomUUID();
    const cases = [0, ...Array.from({ length: 11 }, (_, index) => index + 1)].map(index => ({
      fullName: index === 0
        ? 'case zero <details>\n' + secret + ' ' + 'long '.repeat(80) + 'end of long title'
        : 'unexpected case ' + index,
      status: 'failed',
      failureMessages: ['assertion fixture message'],
    }));
    cases.push({ fullName: 'already expected', status: 'failed', failureMessages: ['baseline message'] });
    cases.push({ fullName: 'passed assertion', status: 'passed' });
    const fixture = path.join(temp, 'input.json');
    const baseline = 'unit\t' + file + '\t' + identity(file, 'already expected') + '\n';
    fs.mkdirSync(path.join(temp, 'config/tooling'), { recursive: true });
    fs.mkdirSync(path.join(temp, 'config/ci'), { recursive: true });
    fs.writeFileSync(path.join(temp, 'config/tooling/jest.config.unit.js'), '');
    fs.writeFileSync(path.join(temp, 'config/ci/known-failures.txt'), baseline);
    fs.writeFileSync(path.join(temp, 'package.json'), JSON.stringify({ scripts: { 'test:unit': 'jest' } }));
    fs.writeFileSync(fixture, JSON.stringify({ testResults: [
      { name: path.join(temp, file), status: 'failed', assertionResults: cases },
    ] }));
    const stub = path.join(temp, 'stub.cjs');
    fs.writeFileSync(stub, [
      'const fs = require("node:fs");',
      'require("node:child_process").spawnSync = (command, args) => {',
      '  if (command === "git") {',
      '    const fixture = { "rev-parse": "a".repeat(40), "ls-tree": "config/ci/known-failures.txt\\0",',
      '      show: process.env.JEST_FIXTURE_BASELINE };',
      '    if (Object.hasOwn(fixture, args[2])) return { status: 0, stdout: fixture[args[2]] };',
      '  }',
      '  if (command === "npm") {',
      '    const output = args.find(arg => arg.startsWith("--outputFile="));',
      '    fs.copyFileSync(process.env.JEST_FIXTURE_INPUT, output.slice("--outputFile=".length));',
      '    return { status: 1, stdout: "", stderr: "" };',
      '  }',
      '  throw new Error("Unexpected child process");',
      '};',
    ].join('\n'));
    const options = {
      cwd: temp, encoding: 'utf8', timeout: 3000,
      env: { ...process.env, GITHUB_EVENT_NAME: 'fixture', GITHUB_SHA: 'b'.repeat(40),
        JEST_SHARD: '', JEST_DIAGNOSTIC_PROPOSAL: '', JEST_FIXTURE_SECRET: secret,
        JEST_FIXTURE_BASELINE: baseline, JEST_FIXTURE_INPUT: fixture,
        GITHUB_STEP_SUMMARY: path.join(temp, 'summary.md'),
        JEST_ARTIFACT_URL: 'https://github.com/MasarX/masarx-platform/actions/runs/12/artifacts/34' },
    };
    const gate = spawnSync(process.execPath, ['--require', stub, path.join(scripts, 'jest.cjs'), 'unit'], options);
    expect(gate.error).toBeUndefined();
    expect(gate.status).toBe(1);
    expect(gate.stderr).toContain('Jest gate failed: UNEXPECTED_ASSERTION_FAILURES');
    const result = path.join(temp, 'ci-reports/jest-results.unit.json');
    const artifact = fs.readFileSync(result, 'utf8');
    expect(JSON.parse(artifact)).toMatchObject({
      ok: false, observedFailures: 13, unexpected: 12, expected: 1, executed: 14,
      reasons: ['UNEXPECTED_ASSERTION_FAILURES'],
    });
    expect(JSON.parse(artifact).suites[0].tests).toHaveLength(14);
    expect(artifact).toContain('assertion fixture message');
    expect(artifact).toContain('end of long title');
    const rendered = spawnSync(process.execPath, [path.join(scripts, 'jest-failure-summary.cjs'), 'unit'], options);
    expect(rendered.error).toBeUndefined();
    expect(rendered.status).toBe(0);
    const summary = fs.readFileSync(options.env.GITHUB_STEP_SUMMARY, 'utf8');
    expect(summary.match(/^tests\/unit\/example\.test\.js ? /gm)).toHaveLength(10);
    expect(summary).toContain('case zero &lt;details&gt; [REDACTED]');
    expect(summary).toContain('2 additional unexpected failures omitted.');
    expect(summary).toContain('[Complete Jest result artifact](' + options.env.JEST_ARTIFACT_URL + ')');
    for (const value of [secret, temp, 'end of long title', 'already expected', 'passed assertion', 'assertion fixture message']) {
      expect(summary).not.toContain(value);
    }
    expect(fs.readFileSync(result, 'utf8')).toBe(artifact);
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});
