const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('daily control-plane cost summary workflow', () => {
  test('runs daily plus manual dispatch on the self-hosted general controller', () => {
    const body = readWorkflow('daily-control-plane-cost-summary.yml');

    expect(body).toContain('schedule:');
    expect(body).toContain("cron: '10 2 * * *'");
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('permissions:');
    expect(body).toContain('contents: read');
    expect(body).toContain('actions: read');
    expect(body).toContain('checks: read');
    expect(body).toContain('pull-requests: read');
    expect(body).toContain('statuses: read');
    expect(body).toContain("group: daily-control-plane-cost-summary-${{ github.event_name == 'workflow_dispatch' && github.event.inputs.days || 'daily' }}");
    expect(body).not.toContain('resolve_control_plane_runner:');
    expect(body).toContain('runs-on: ${{ fromJSON(vars.RUNNER_RUNS_ON_LINUX_LOCAL_JSON) }}');
    expect(body).not.toContain('RUNNER_LABELS_LINUX_GITHUB_JSON');
    expect(body).not.toContain('LINUX_RUNNER_POLICY');
    expect(body).not.toContain('LOCAL_RUNNER_PLATFORM_STATE');
  });

  test('reuses ci-slo-report with a control-plane workflow filter and publishes dedicated artifacts', () => {
    const body = readWorkflow('daily-control-plane-cost-summary.yml');

    expect(body).toContain('Generate daily control-plane cost summary');
    expect(body).toContain('READ_GITHUB_TOKEN: ${{ steps.token.outputs.token || github.token }}');
    expect(body).toContain('STATUS_GITHUB_TOKEN: ${{ github.token }}');
    expect(body).toContain("vars.CONTROL_PLANE_COST_SUMMARY_LOOKBACK_DAYS || '1'");
    expect(body).toContain("vars.CONTROL_PLANE_COST_SUMMARY_WORKFLOWS || 'CI checks,Branch Convergence Remote Proof,Release Verify (main),CI SLO Report,Control Plane Drift Audit'");
    expect(body).not.toContain('PR Gate (Preview + Verify)');
    expect(body).toContain('node scripts/ops/ci/ci-slo-report.js');
    expect(body).toContain('--workflows "$WORKFLOW_NAMES"');
    expect(body).toContain('control-plane-cost-summary.json');
    expect(body).toContain('control-plane-cost-summary.md');
    expect(body).toContain('control-plane-queue-health-summary.json');
    expect(body).toContain('control-plane-queue-health-summary.md');
    expect(body).toContain('Upload control-plane cost summary artifact');
  });
});
