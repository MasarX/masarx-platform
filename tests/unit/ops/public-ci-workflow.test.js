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
    expect(workflow.jobs.unit.strategy['fail-fast']).toBe(false);
    for (const lane of ['unit', 'ui']) {
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

  test('fits the job cap with two unit shards, one UI job and grouped app checks', () => {
    const { jobs } = workflow;
    const shard = '${{ matrix.shard }}/${{ strategy.job-total }}';
    expect(jobs.unit.strategy.matrix.shard).toEqual([1, 2]);
    expect(jobs.unit.env.JEST_SHARD).toBe(shard);
    expect(jobs.ui.strategy).toBeUndefined();
    expect(jobs.ui.env?.JEST_SHARD).toBeUndefined();
    expect(jobs.typecheck.strategy).toBeUndefined();
    expect(jobs.typecheck.steps.at(-1).run).toContain('for subject in apps/console apps/portal apps/fieldops; do');
    expect(jobs.typecheck.steps.at(-1).run).toContain('node scripts/ci-hosted/tasks.cjs typecheck "$subject" || result=$?');
    const consoleSteps = jobs['build-console'].steps;
    const legacyBuildIndex = consoleSteps.findIndex(step => step.name === 'Build present console');
    const liveBuildIndex = consoleSteps.findIndex(step => step.name === 'Build Console V2 in live mode');
    const budgetIndex = consoleSteps.findIndex(step => step.name === 'Check live Console V2 bundle size');
    expect(consoleSteps[legacyBuildIndex]?.run).toBe('node scripts/ci-hosted/tasks.cjs build apps/console');
    expect(consoleSteps[liveBuildIndex]?.run).toBe(
      `export VITE_SUPABASE_ANON_KEY="$(node -p "require('node:crypto').randomBytes(32).toString('hex')")"\n`
      + 'npm run build --workspace @masarx/console-v2\n',
    );
    expect(consoleSteps[budgetIndex]?.run).toBe('npm run check:bundle-size --workspace @masarx/console-v2');
    expect(liveBuildIndex).toBeGreaterThan(legacyBuildIndex);
    expect(budgetIndex).toBeGreaterThan(liveBuildIndex);
    expect(jobs['build-portal-landing'].steps.slice(-2).map(step => step.run)).toEqual([
      'node scripts/ci-hosted/tasks.cjs build apps/portal',
      'node scripts/ci-hosted/tasks.cjs build landing',
    ]);
    expect(Object.values(jobs).reduce((total, job) => total + (job.strategy?.matrix.shard.length ?? 1), 0)).toBe(20);
    for (const job of Object.values(jobs)) expect(job.strategy?.['max-parallel']).toBeUndefined();
    expect(workflow.env.JEST_RETRY_TIMES).toBe('0');
    const landing = fs.readFileSync(path.resolve(__dirname, '../../../scripts/ci-hosted/playwright.landing.config.cjs'), 'utf8');
    expect(landing).toMatch(/^  retries: 0,$/m);
  });

  test('runs six independent from-zero pgTAP shards whenever database is affected', () => {
    const build = workflow.jobs['database-build'];
    const shards = workflow.jobs['database-pgtap'];
    expect(PGTAP_SHARD_COUNT).toBe(6);
    expect(shards.strategy.matrix.shard).toEqual(Array.from({ length: PGTAP_SHARD_COUNT }, (_, index) => index + 1));
    expect(shards.strategy['fail-fast']).toBe(false);
    expect(shards.env.PGTAP_SHARD).toBe('${{ matrix.shard }}/${{ strategy.job-total }}');
    for (const job of [build, shards]) {
      expect(job.needs).toBe('append-only');
      expect(job['timeout-minutes']).toBe(20);
      expect(job.steps.find(step => step.id === 'subject').run).toBe('node scripts/ci-hosted/tasks.cjs detect database');
      expect(job.steps.find(step => step.run === 'node scripts/ci-hosted/backend.cjs').if).toBe("steps.subject.outputs.present == 'true'");
    }
    expect(workflow.jobs.database.needs).toEqual(['append-only', 'database-build', 'database-pgtap']);
    expect(workflow.jobs.database.steps[0].with['sparse-checkout'].split('\n')).toContain('supabase/tests/pgtap');
  });

  test('selects affected jobs from the pull request base and runs every gate when selection is unavailable', () => {
    const { jobs } = workflow;
    const changes = jobs['append-only'].steps.find(step => step.id === 'changes');
    expect(changes.if).toBe("github.event_name == 'pull_request'");
    expect(changes.run).toContain("git rev-parse --verify 'HEAD^1^{commit}'");
    expect(changes.run).toContain('git show "$base:scripts/ci-hosted/changes.cjs" > "$RUNNER_TEMP/changes.cjs"');
    expect(changes.run).toContain('node "$RUNNER_TEMP/changes.cjs" "$base"');
    const affected = {
      database: ['database'],
      'database-build': ['database'],
      'database-pgtap': ['database'],
      typecheck: ['typecheck'],
      unit: ['unit'],
      ui: ['ui'],
      'build-console': ['build_console'],
      'build-portal-landing': ['build_portal', 'build_landing'],
      e2e: ['e2e'],
    };
    for (const [name, gates] of Object.entries(affected)) {
      const status = name === 'database' ? 'always()' : '!cancelled()';
      const outputs = gates.map(gate => `needs.append-only.outputs.${gate} != 'false'`).join(' || ');
      expect([jobs[name].needs].flat()).toContain('append-only');
      expect(jobs[name].if).toBe(`\${{ ${status} && (needs.append-only.result != 'success' || ${outputs}) }}`);
      for (const gate of gates) expect(jobs['append-only'].outputs[gate]).toBe(`\${{ steps.changes.outputs.${gate} }}`);
    }
  });

  test('restores npm cache read-only except on a trunk push and keeps visual prerequisites first', () => {
    const { jobs } = workflow;
    for (const name of ['lint', 'typecheck', 'unit', 'ui', 'build-console', 'build-portal-landing', 'e2e', 'visual-baselines']) {
      const setup = jobs[name].steps.find(step => step.uses?.startsWith('actions/setup-node@'));
      const restore = jobs[name].steps.find(step => step.name === 'Restore npm cache');
      expect(setup.uses).toMatch(/^actions\/setup-node@[a-f0-9]{40}$/);
      expect(setup.with['package-manager-cache']).toBe(false);
      expect(setup.with.cache).toBe("${{ github.event_name == 'push' && github.ref == 'refs/heads/main' && 'npm' || '' }}");
      expect(setup.with['cache-dependency-path']).toBe('package-lock.json');
      expect(restore.uses).toMatch(/^actions\/cache\/restore@[a-f0-9]{40}$/);
      expect(restore.if).toContain("github.event_name != 'push' || github.ref != 'refs/heads/main'");
      expect(restore.with.path).toBe('${{ runner.temp }}/npm-cache');
      expect(setup.env.NPM_CONFIG_CACHE).toBe(restore.with.path);
      expect(jobs[name].steps.find(step => step.id === 'install').env.NPM_CONFIG_CACHE).toBe(restore.with.path);
      expect(restore.with.key).toBe("node-cache-${{ runner.os }}-x64-npm-${{ hashFiles('package-lock.json') }}");
    }
    const visual = jobs['visual-baselines'];
    expect(visual.if).toBe("github.event_name == 'workflow_dispatch' && inputs.regenerate_visual_baselines");
    expect(visual.steps.findIndex(step => step.run === 'node scripts/ci-hosted/tasks.cjs visual-preflight'))
      .toBeLessThan(visual.steps.findIndex(step => step.id === 'install'));
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
    expect(result.steps[0].env.AFFECTED_REQUESTED).toBe("${{ github.event_name == 'pull_request' }}");
    expect(command).toContain("gates = selector.get('outputs', {}) if selector.get('result') == 'success' else {}");
    expect(command).toContain("and all(gates.get(gate) == 'false' for gate in affected_jobs[name])):");
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
