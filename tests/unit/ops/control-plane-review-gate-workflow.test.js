const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('control-plane-review-gate workflow', () => {
  test('runs on dev/main PRs and manual dispatch only', () => {
    const body = readWorkflow('control-plane-review-gate.yml');
    expect(body).toContain('pull_request:');
    expect(body).toContain('branches: [dev, main]');
    expect(body).not.toContain('merge_group:');
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('pr_number:');
    expect(body).toContain("group: control-plane-review-gate-${{ github.event.pull_request.number || inputs.pr_number || github.ref || github.run_id }}");
  });

  test('uses pinned actions and the control-plane review script', () => {
    const body = readWorkflow('control-plane-review-gate.yml');
    expect(body).toContain('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
    expect(body).toContain('Check bundled Node 24');
    expect(body).toContain("if: steps.bundled_node.outputs.ready != 'true'");
    expect(body).toContain('actions/setup-node@53b83947a5a98c8d113130e565377fae1a50d02f');
    expect(body).toContain('control_plane_review_gate:');
    expect(body).not.toContain('resolve_pr_admission_runner:');
    expect(body).not.toContain('resolve-linux-runner.yml@v1');
    expect(body).toContain('ENTERPRISE_RUNNER_BREAKGLASS');
    expect(body).toContain('RUNNER_LABELS_CI_PR_ADMISSION_JSON');
    expect(body).not.toContain('runs-on: ubuntu-latest');
    expect(body).toContain('node scripts/ops/ci/control-plane-review-gate.js');
    expect(body).toContain('Protected change detected:');
    expect(body).toContain('Required approvers:');
  });
});