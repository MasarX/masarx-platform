const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
const workflow = yaml.parse(body);

describe('public CI workflow contract', () => {
  test('validates pull requests and merge groups with read-only permissions', () => {
    expect(workflow.on).toHaveProperty('pull_request');
    expect(workflow.on.merge_group.types).toContain('checks_requested');
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  test('keeps trusted test execution, non-cancelling shards and helper selfchecks', () => {
    for (const lane of ['unit', 'ui']) {
      expect(workflow.jobs[lane].strategy['fail-fast']).toBe(false);
      expect(workflow.jobs[lane].steps.some(step => step.run === `node scripts/ci-hosted/base-guard.cjs jest.cjs ${lane}`)).toBe(true);
    }
    const checks = workflow.jobs['append-only'].steps.find(step => step.name === 'Check proposed helper behavior');
    expect(checks.run).toContain('node scripts/ci-hosted/selfcheck.cjs');
    expect(checks.run).toContain('node scripts/ci-hosted/shard-selfcheck.cjs');
  });

  test('requires every producer and only permits the optional visual lane to skip', () => {
    const result = workflow.jobs['ci-result'];
    expect(result.if).toBe('always()');
    expect([...result.needs].sort()).toEqual(Object.keys(workflow.jobs).filter(name => name !== 'ci-result').sort());
    const command = result.steps[0].run;
    expect(command).toContain('good = set(needs) == expected');
    expect(command).toContain("allowed = {'success'}");
    expect(command).toContain("if name == 'visual-baselines' and os.environ['VISUAL_REQUESTED'] != 'true':");
    expect(command).toContain('sys.exit(0 if good else 1)');
    expect(body).not.toContain('continue-on-error: true');
  });
});
