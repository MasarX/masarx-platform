// The Console V2 axe suite runs in hosted CI on seed data and fails the job on a violation (#301).
const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const root = path.resolve(__dirname, '../../..');
const workflow = yaml.parse(fs.readFileSync(path.join(root, '.github/workflows/public-ci.yml'), 'utf8'));
const steps = workflow.jobs.e2e.steps;
const run = steps.find((step) => step.id === 'console_a11y');
process.env.A11Y_EVIDENCE_DIR = run.env.A11Y_EVIDENCE_DIR;
const config = require(path.join(root, 'scripts/ci-hosted/playwright.console-a11y.config.cjs'));

describe('Console V2 accessibility in hosted CI', () => {
  test('the browser job runs the suite without continue-on-error', () => {
    expect(run.run).toBe('node scripts/ci-hosted/tasks.cjs console-a11y');
    expect(run['continue-on-error']).toBeUndefined();
    expect(run.if).toContain("steps.console.outputs.present == 'true'");
    expect(steps.find((step) => step.id === 'console').run).toBe('node scripts/ci-hosted/tasks.cjs detect apps/console-v2');
    const upload = steps.find((step) => step.name === 'Upload Console V2 axe evidence');
    expect(upload.with.path).toBe(run.env.A11Y_EVIDENCE_DIR);
    expect(upload.with['if-no-files-found']).toBe('error');
  });

  test('the config writes its JSON report into the uploaded evidence folder', () => {
    const json = config.reporter.find(([name]) => name === 'json');
    expect(path.dirname(json[1].outputFile)).toBe(path.join(root, run.env.A11Y_EVIDENCE_DIR));
  });

  test('the config targets the Console V2 suite on a seed-mode local server with no retries', () => {
    expect(config.testDir).toBe(path.join(root, 'apps/console-v2/tests/a11y'));
    expect(config.retries).toBe(0);
    expect(config.forbidOnly).toBe(true);
    const server = config.webServer.find((entry) => entry.cwd === path.join(root, 'apps/console-v2'));
    expect(server.env.VITE_USE_SEED).toBe('true');
    expect(server.env.VITE_SUPABASE_URL).toBe('');
    expect(server.url).toBe(config.use.baseURL);
    expect(config.use.proxy.server).toBe('http://127.0.0.1:3334');
  });
});
