const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('ci-slo-report workflow', () => {
  test('runs on schedule and workflow_dispatch with reporting read access plus issue refresh write access', () => {
    const body = readWorkflow('ci-slo-report.yml');
    expect(body).toContain('schedule:');
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('permissions:');
    expect(body).toContain('contents: read');
    expect(body).toContain('actions: read');
    expect(body).toContain('checks: read');
    expect(body).toContain('pull-requests: read');
    expect(body).toContain('statuses: read');
    expect(body).toContain('issues: write');
  });

  test('generates report artifacts and refreshes the tracked CI health issue', () => {
    const body = readWorkflow('ci-slo-report.yml');
    expect(body).toContain('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
    expect(body).toContain("EXAMPLE_PASSWORD: ${{ secrets.PLAN_AUTOMATION_PR_TOKEN || github.token }}");
    expect(body).toContain('probe-url: https://api.github.com/repos/${{ github.repository }}/actions/runs?per_page=1');
    expect(body).toContain('READ_GITHUB_TOKEN: ${{ steps.token.outputs.token || github.token }}');
    expect(body).toContain('STATUS_GITHUB_TOKEN: ${{ github.token }}');
    expect(body).toContain('actions/upload-artifact@bbbca2ddaa5d8feaa63e36b76fdaad77386f024f');
    expect(body).toContain('continue-on-error: true');
    expect(body).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(body).toContain('node scripts/ops/ci/ci-slo-report.js');
    expect(body).toContain('--target-base "$TARGET_BASE"');
    expect(body).toContain('READY_PR_STALE_MAX_MINUTES');
    expect(body).toContain('DEPLOY_CIRCUIT_THRESHOLD');
    expect(body).toContain('DEPLOY_CIRCUIT_WINDOW_HOURS');
    expect(body).toContain('ci-slo-report.json');
    expect(body).toContain('ci-slo-report.md');
    expect(body).toContain('queue-health-summary.json');
    expect(body).toContain('queue-health-summary.md');
    expect(body).toContain('Refresh CI health issue');
    expect(body).toContain('upsertCiHealthIssue');
  });
});
