const fs = require('fs');
const path = require('path');

describe('leader-worker-issue-sync workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'leader-worker-issue-sync.yml',
  );

  test('requires rich assignment context and references', () => {
    const body = fs.readFileSync(workflowFile, 'utf8').replace(/\r\n/g, '\n');

    expect(body).not.toContain('\n  issues:\n');
    expect(body).not.toContain('\n  push:\n');
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('issue_number:');
    expect(body).toContain('refresh_all:');
    expect(body).toContain("github.event_name == 'workflow_dispatch' && inputs.issue_number != ''");
    expect(body).toContain("const issueIsOpen = String(issue?.state || '').toLowerCase() === 'open';");
    expect(body).toContain('is closed; skipping dispatch relabel and snapshot refresh.');
    expect(body).toContain('isAssignmentIssueCandidate');
    expect(body).toContain("title: issue?.title || ''");
    expect(body).not.toContain("Boolean(contract.planId || contract.step)");
    expect(body).toContain('function isPlaceholder(value)');
    expect(body).toContain('Missing `Review Policy: required|optional` in issue body.');
    expect(body).toContain('Missing or placeholder `Context:` in issue body.');
    expect(body).toContain('Missing or placeholder `References:` in issue body.');
    expect(body).toContain('Missing or placeholder `Plan Snapshot:` in issue body.');
    expect(body).toContain("(/^<[^>\\n]+>$/.test(raw) && !raw.startsWith('<!--'))");
    expect(body).not.toContain("v.startsWith('<')");
    expect(body).toContain('replacePlanSnapshotSection');
    expect(body).toContain('normalizeAssignmentToDone');
    expect(body).toContain("status: 'archived_terminal'");
    expect(body).toContain('is archived with terminal status');
    expect(body).toContain('normalized assignment to \\`dispatch:done\\`.');
    expect(body).toContain('Plan Snapshot auto-refresh failed');
    expect(body).toContain('<!-- masarx-worker-plan-snapshot -->');
    expect(body).toContain("if: ${{ vars.LEGACY_WORKER_PLAN_AUTOMATION_ENABLED == '1' && github.event_name == 'workflow_dispatch' && inputs.refresh_all == '1' }}");
    expect(body).toContain('Unable to re-check assignment issue #${issueNumber} before relabel');
    expect(body).toContain('became closed during sync; skipping relabel and snapshot update.');
    expect(body).toContain('Unable to load assignment issue #${issueNumber} for snapshot refresh');
    expect(body).toContain('Skipping assignment issue #${issueNumber}: issue is now closed.');
  });
});
