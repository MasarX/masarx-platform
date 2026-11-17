const fs = require('fs');
const path = require('path');

describe('issue-stale-governance workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'issue-stale-governance.yml',
  );

  test('has scheduled and manual dispatch triggers', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain('name: Issue Stale Governance');
    expect(body).toContain('schedule:');
    expect(body).toContain("cron: '15 4 * * *'");
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('mode:');
    expect(body).toContain('dry_run:');
  });

  test('uses least-privilege permissions and policy script', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain('issues: write');
    expect(body).toContain('pull-requests: read');
    expect(body).toContain("ISSUE_STALE_ENABLED: ${{ vars.ISSUE_STALE_ENABLED || '1' }}");
    expect(body).toContain("ISSUE_STALE_MODE: ${{ vars.ISSUE_STALE_MODE || 'mark_and_close' }}");
    expect(body).toContain("const configPath = path.join(process.cwd(), 'config', 'ci', 'stale-issues.json');");
    expect(body).toContain('runStaleIssueGovernance');
  });
});
