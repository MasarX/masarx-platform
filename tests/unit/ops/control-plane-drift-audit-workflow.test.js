const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('control-plane-drift-audit workflow', () => {
  test('runs on schedule and manual dispatch with automation-token-backed drift checks', () => {
    const body = readWorkflow('control-plane-drift-audit.yml');
    expect(body).toContain('schedule:');
    expect(body).toContain("cron: '10 4 * * *'");
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('./.github/actions/mint-automation-token');
    expect(body).toContain("EXAMPLE_PASSWORD: ${{ secrets.PLAN_AUTOMATION_PR_TOKEN || github.token }}");
    expect(body).toContain('GITHUB_TOKEN: ${{ github.token }}');
    expect(body).toContain("GITHUB_AUDIT_ADMIN_TOKEN: ${{ secrets.PLAN_AUTOMATION_AUDIT_TOKEN || steps.token.outputs.token || github.token }}");
    expect(body).toContain('node scripts/ops/ci/control-plane-drift-audit.js');
    expect(body).toContain('control-plane-drift-audit.json');
    expect(body).toContain('control-plane-drift-audit.md');
    expect(body).toContain('Refresh control-plane drift issue');
    expect(body).toContain("CONTROL_PLANE_DRIFT_ISSUE_LABEL: ${{ vars.CONTROL_PLANE_DRIFT_ISSUE_LABEL || 'ops:control-plane-drift' }}");
    expect(body).toContain('<!-- masarx-control-plane-drift -->');
    expect(body).toContain("const label = String(process.env.CONTROL_PLANE_DRIFT_ISSUE_LABEL || 'ops:control-plane-drift').trim() || 'ops:control-plane-drift';");
    expect(body).toContain("No drift detected; no tracked issue to close.");
    expect(body).toContain("Closed issue #${existing.number}.");
  });
});
