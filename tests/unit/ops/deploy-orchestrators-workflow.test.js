const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs
    .readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8')
    .replace(/\r\n/g, '\n');
}

function extractTopLevelConcurrency(body) {
  const match = body.match(/^concurrency:\n(?: {2}.*\n?)+/m);
  return match ? match[0] : '';
}

describe('deploy orchestrator workflows', () => {
  test('dev orchestrator dispatches stage-filtered targets for pushes to dev', () => {
    const body = readWorkflow('deploy-dev-orchestrator.yml');
    expect(body).toContain('branches: [dev]');
    expect(body).toContain('changed-surfaces.js --stage dev --format github-output');
    expect(body).toContain('resolve-orchestrator-targets.js');
    expect(body).toContain('--stage dev');
    expect(body).toContain('fetch-depth: 1');
    expect(body).toContain('filter: blob:none');
    expect(body).toContain('sparse-checkout: |');
    expect(body).toContain('.github/workflows');
    expect(body).toContain('git fetch --no-tags --depth=1 origin "${{ github.event.before }}"');
    expect(body).toContain("ref: 'dev'");
    expect(body).toContain('retries: 3');
    expect(body).toContain('retry-exempt-status-codes: 400,401,403,404,422');
    expect(body).toContain('fromJson(needs.resolve.outputs.primary_targets_json)');
    expect(body).toContain('dispatch_dependent:');
    expect(body).toContain('fromJson(needs.resolve.outputs.dependent_targets_json)');
    expect(body).toContain('needs.resolve.outputs.has_dependent_targets == \'1\'');
    expect(body).toContain('wait_children:');
    expect(body).toContain('wait_dependent:');
    expect(body).toContain('orchestrator-wait-children.js');
    expect(body).toContain('dev-orchestrator-child-runs');
    expect(body).toContain('dev-orchestrator-dependent-child-runs');
    expect(body).toContain('RUNNER_RUNS_ON_LINUX_LOCAL_JSON');
    expect(body).not.toContain('RUNNER_RUNS_ON_PR_ADMISSION_LOCAL_JSON');
    expect(body).toContain('continue-on-error: true');
    const waitChildrenBlock = body.split('wait_children:')[1];
    expect(waitChildrenBlock).toBeTruthy();
    expect(waitChildrenBlock).toContain('RUNNER_RUNS_ON_LINUX_LOCAL_JSON');
    expect(waitChildrenBlock).toContain('- name: Checkout');
    expect(waitChildrenBlock).toContain('uses: actions/checkout@');
    expect(waitChildrenBlock).toContain('fetch-depth: 1');
    expect(waitChildrenBlock).toContain("ref: ${{ needs.resolve.outputs.deploy_sha || github.sha }}");
    expect(waitChildrenBlock).toContain('filter: blob:none');
    expect(waitChildrenBlock).toContain('sparse-checkout-cone-mode: false');
    expect(waitChildrenBlock).toContain('scripts/ops/ci/orchestrator-wait-children.js');
    expect(waitChildrenBlock).toContain('scripts/ops/ci/github-api-retry.js');
    expect(waitChildrenBlock.indexOf('- name: Checkout')).toBeLessThan(
      waitChildrenBlock.indexOf('- name: Wait for child workflows'),
    );
    expect(body).not.toContain('approval_mode');
    expect(body).not.toContain('environment: ${{ matrix.target.approval_env_surface }}');
  });

  test('orchestrators serialize by deployment stage without canceling active runs', () => {
    const cases = [
      ['deploy-dev-orchestrator.yml', 'group: deploy-orchestrator-dev'],
      ['deploy-stg-orchestrator.yml', 'group: deploy-orchestrator-stg'],
      ['deploy-prod-orchestrator.yml', 'group: deploy-orchestrator-prod'],
    ];

    for (const [workflow, expectedGroup] of cases) {
      const concurrency = extractTopLevelConcurrency(readWorkflow(workflow));
      expect(concurrency).toContain(expectedGroup);
      expect(concurrency).toContain('cancel-in-progress: false');
      expect(concurrency).not.toMatch(/github\.sha|inputs\.ref|github\.event\.inputs\.ref|github\.run_id/);
    }
  });

  test('stg orchestrator filters to stage-supported surfaces and dispatches targets without approval wait jobs', () => {
    const body = readWorkflow('deploy-stg-orchestrator.yml');
    expect(body).toContain('changed-surfaces.js --stage stg --format github-output');
    expect(body).toContain('resolve-orchestrator-targets.js');
    expect(body).toContain('--stage stg');
    expect(body).toContain('RUNNER_RUNS_ON_LINUX_LOCAL_JSON');
    expect(body).not.toContain('RUNNER_RUNS_ON_PR_ADMISSION_LOCAL_JSON');
    expect(body).not.toContain('runs-on: ubuntu-latest');
    expect(body).toContain('retries: 3');
    expect(body).toContain('retry-exempt-status-codes: 400,401,403,404,422');
    expect(body).toContain('fromJson(needs.resolve.outputs.primary_targets_json)');
    expect(body).toContain('dispatch_dependent:');
    expect(body).toContain('fromJson(needs.resolve.outputs.dependent_targets_json)');
    expect(body).toContain('needs.resolve.outputs.has_dependent_targets == \'1\'');
    expect(body).toContain('wait_children:');
    expect(body).toContain('wait_dependent:');
    expect(body).toContain('orchestrator-wait-children.js');
    expect(body).toContain('stg-orchestrator-child-runs');
    expect(body).toContain('stg-orchestrator-dependent-child-runs');
    expect(body).toMatch(/permissions:\s*\r?\n\s*contents: read/);
    expect(body).toContain("needs.resolve.result == 'success' && needs.resolve.outputs.skip != '1'");
    expect(body).toMatch(/permissions:\s*\r?\n\s*actions: write\r?\n\s*contents: read/);
    expect(body).not.toContain('approval_mode');
    expect(body).not.toContain('approve_commit:');
    expect(body).not.toContain('dispatch_surface_mode:');
    expect(body).not.toContain('dispatch_commit_mode:');
    expect(body).not.toContain('matrix.target.approval_env_surface');
    expect(body).not.toContain('environment: ${{ needs.resolve.outputs.commit_approval_env }}');
  });

  test('prod orchestrator uses dynamic resolver + stg-success guard + per-surface approval only', () => {
    const body = readWorkflow('deploy-prod-orchestrator.yml');
    expect(body).toContain('node scripts/ops/ci/resolve-prod-surfaces.js');
    expect(body).toContain('resolve-orchestrator-targets.js');
    expect(body).toContain('--stage prod');
    expect(body).toContain('RUNNER_RUNS_ON_LINUX_LOCAL_JSON');
    expect(body).not.toContain('RUNNER_RUNS_ON_PR_ADMISSION_LOCAL_JSON');
    expect(body).toContain('retries: 3');
    expect(body).toContain('retry-exempt-status-codes: 400,401,403,404,422');
    expect(body).toContain('Require successful stg deploy(s) for SHA (surface-aware)');
    expect(body).toContain('STG_WORKFLOW="$(');
    expect(body).toContain('--workflow "$STG_WORKFLOW"');
    expect(body).toContain('require-stg-deploy.js');
    expect(body).toContain('deployments: read');
    expect(body).toContain('dispatch:');
    expect(body).toContain('environment: ${{ matrix.target.approval_env_surface }}');
    expect(body).not.toContain('approval_mode:');
    expect(body).not.toContain('approve_commit:');
    expect(body).not.toContain('dispatch_commit_mode:');
    expect(body).toContain("needs.resolve.result == 'success'");
  });
});
