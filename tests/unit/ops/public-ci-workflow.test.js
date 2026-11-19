const fs = require('node:fs');
const path = require('node:path');
const { runInNewContext } = require('node:vm');
const yaml = require('yaml');
const { PGTAP_SHARD_COUNT } = require('../../../scripts/ci-hosted/database-result.cjs');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
const workflow = yaml.parse(body);

describe('public CI workflow contract', () => {
  test('validates pull requests and merge groups with read-only permissions', () => {
    expect(workflow.name).toBe('ci');
    expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened']);
    expect(workflow.on.merge_group.types).toContain('checks_requested');
    expect(workflow.on.push).toBeUndefined();
    expect(workflow.on.workflow_dispatch).toBeDefined();
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(workflow.concurrency['cancel-in-progress']).toBe("${{ github.event_name == 'pull_request' }}");
  });

  test('reports the unqualified base branch for merge-group payloads', () => {
    const expression = workflow.env.CI_BASE_BRANCH.slice(3, -2);
    for (const branch of ['dev', 'main', 'release/trunk']) {
      for (const baseRef of [`refs/heads/${branch}`, branch]) {
        const github = {
          event_name: 'merge_group',
          event: {
            pull_request: { base: {} },
            repository: { default_branch: branch },
            merge_group: { base_ref: baseRef },
          },
          ref_name: `gh-readonly-queue/${branch}/synthetic`,
        };
        expect(runInNewContext(expression, {
          github,
          format: (template, value) => template.replace('{0}', value),
          startsWith: (value, prefix) => value.startsWith(prefix),
        }, { timeout: 1000 })).toBe(branch);
      }
    }
  });

  test('keeps trusted test execution, non-cancelling shards and helper selfchecks', () => {
    for (const lane of ['unit', 'ui']) {
      expect(workflow.jobs[lane].strategy['fail-fast']).toBe(false);
      expect(workflow.jobs[lane].steps.some(step => step.run === `node scripts/ci-hosted/base-guard.cjs jest.cjs ${lane}`)).toBe(true);
    }
    const appendOnly = workflow.jobs['append-only'].steps;
    const installPolicy = appendOnly.find(step => step.name === 'Check candidate install policy with base code');
    expect(installPolicy.run).toBe('node scripts/ci-hosted/base-guard.cjs install-policy.cjs');
    expect(installPolicy.if).toBe("github.event_name == 'pull_request' || github.event_name == 'merge_group'");
    const checks = appendOnly.find(step => step.name === 'Check proposed helper behavior');
    expect(checks.run).toContain('node scripts/ci-hosted/selfcheck.cjs');
    expect(checks.run).toContain('node scripts/ci-hosted/shard-selfcheck.cjs');
    expect(checks.run).toContain('node scripts/ci-hosted/database-selfcheck.cjs');
  });

  test('starts the build and all pgTAP shards independently and keeps both required', () => {
    const build = workflow.jobs['database-build'];
    const shards = workflow.jobs['database-pgtap'];
    expect(PGTAP_SHARD_COUNT).toBe(12);
    expect(shards.strategy.matrix.shard).toEqual(Array.from({ length: PGTAP_SHARD_COUNT }, (_, index) => index + 1));
    expect(shards.strategy['fail-fast']).toBe(false);
    expect(shards.env.PGTAP_SHARD).toBe('${{ matrix.shard }}/${{ strategy.job-total }}');
    for (const job of [build, shards]) {
      expect(job.needs).toBeUndefined();
      expect(job.if).toBeUndefined();
      expect(job['timeout-minutes']).toBe(20);
      expect(job.steps.find(step => step.id === 'subject').run).toBe('node scripts/ci-hosted/tasks.cjs detect database');
      expect(job.steps.find(step => step.run === 'node scripts/ci-hosted/backend.cjs').if).toBe("steps.subject.outputs.present == 'true'");
    }
    expect(workflow.jobs.database.needs).toEqual(['database-build', 'database-pgtap']);
    expect(workflow.jobs.database.if).toBe('always()');
    expect(workflow.jobs.database.steps[0].with['sparse-checkout'].split('\n')).toContain('supabase/tests/pgtap');
  });

  test('requires every producer and rejects unexpected skips', () => {
    const result = workflow.jobs['ci-gate'];
    expect(result.name).toBe('ci-gate');
    expect(result.if).toBe('always()');
    expect([...result.needs].sort()).toEqual(Object.keys(workflow.jobs).filter(name => name !== 'ci-gate').sort());
    const command = result.steps[0].run;
    expect(command).toContain('good = set(needs) == expected');
    expect(command).toContain("allowed = {'success'}");
    expect(command).toContain("if name == 'visual-baselines' and os.environ['VISUAL_REQUESTED'] != 'true':");
    expect(command).toContain("if name == 'dependency-review' and os.environ['DEPENDENCY_REVIEW_REQUESTED'] != 'true':");
    expect(command).toContain('sys.exit(0 if good else 1)');
    const downloadAction = 'actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333';
    const optionalTransfers = {
      'database/Download build report': downloadAction,
      'database/Download all pgTAP reports': downloadAction,
    };
    for (const [name, job] of Object.entries(workflow.jobs)) {
      expect(job['continue-on-error']).not.toBe(true);
      for (const step of job.steps) {
        if (step['continue-on-error'] === true) {
          expect(step.uses).toBe(optionalTransfers[`${name}/${step.name}`]);
          expect(step.run).toBeUndefined();
        }
      }
    }
    const database = workflow.jobs.database;
    expect(database.steps.at(-1).if).toBe('always()');
    expect(database.steps.at(-1).run).toBe('node scripts/ci-hosted/database-result.cjs');
    expect(body).toContain('node scripts/ci-hosted/backend.cjs');
  });

  test('reviews pull request dependencies at high severity with a read-only token', () => {
    const review = workflow.jobs['dependency-review'];
    expect(review.if).toBe("github.event_name == 'pull_request'");
    expect(review.permissions).toEqual({ contents: 'read' });
    expect(review.steps).toEqual([{
      uses: expect.stringMatching(/^actions\/dependency-review-action@[a-f0-9]{40}$/),
      with: { 'fail-on-severity': 'high' },
    }]);
    expect(workflow.jobs['ci-gate'].steps[0].env.DEPENDENCY_REVIEW_REQUESTED).toBe("${{ github.event_name == 'pull_request' }}");
  });
});
