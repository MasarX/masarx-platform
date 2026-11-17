const fs = require('node:fs');
const path = require('node:path');
const yaml = require('yaml');

const body = fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/public-ci.yml'), 'utf8');
const workflow = yaml.parse(body);

describe('public CI workflow contract', () => {
  test('validates pull requests and merge groups with read-only permissions', () => {
    expect(workflow.name).toBe('ci');
    expect(workflow.on.pull_request.types).toEqual(['opened', 'synchronize', 'reopened', 'edited']);
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
    expect(command).toContain("if name == 'main-admission' and os.environ['MAIN_ADMISSION_REQUESTED'] != 'true':");
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

  test('requires main admission on retargets and runs the base guard with read-only access', () => {
    const main = workflow.jobs['main-admission'];
    expect(main.if).toBe("github.event_name == 'pull_request' && github.event.pull_request.base.ref == 'main'");
    expect(workflow.jobs['ci-gate'].steps[0].env.MAIN_ADMISSION_REQUESTED).toBe('${{ ' + main.if + ' }}');
    expect(main.permissions).toEqual({ contents: 'read' });
    expect(main.steps[0].env.BASE_SHA).toBe('${{ github.event.pull_request.base.sha }}');
    expect(main.steps[0].run).toContain('[[ "$BASE_SHA" =~ ^[a-f0-9]{40}$ ]]');
    const checkout = main.steps.find(step => step.uses?.startsWith('actions/checkout@'));
    expect(checkout.with).toMatchObject({
      ref: '${{ steps.source.outputs.base }}',
      'persist-credentials': false,
      'sparse-checkout': 'scripts/ci-hosted',
    });
    expect(main.steps.at(-1).run).toBe('node scripts/ci-hosted/policy.cjs');
  });

  test('comments once on the merged hotfix with the back-merge link and title', () => {
    const backmerge = yaml.parse(fs.readFileSync(path.resolve(__dirname, '../../../.github/workflows/hotfix-backmerge.yml'), 'utf8'));
    expect(backmerge.on).toEqual({ pull_request: { types: ['closed'], branches: ['main'] } });
    expect(backmerge.permissions).toEqual({ 'pull-requests': 'write' });
    const job = backmerge.jobs.backmerge;
    expect(job.if).toContain('github.event.pull_request.merged');
    expect(job.if).toContain('github.event.pull_request.head.repo.id == github.event.repository.id');
    expect(job.steps).toHaveLength(1);
    expect(job.steps[0].uses).toBeUndefined();
    expect(job.steps[0].env.GH_TOKEN).toBe('${{ github.token }}');
    const command = job.steps[0].run;
    expect(command).toContain('issues/$PR_NUMBER/comments');
    expect(command).toContain('<!-- hotfix-backmerge -->');
    expect(command).toContain('[[ -z "$existing" ]] || exit 0');
    expect(command).toContain('Back-merge hotfix into dev');
    expect(command).toContain('$compare/main...dev');
    expect(command).toContain('$compare/dev...main?expand=1');
  });
});
