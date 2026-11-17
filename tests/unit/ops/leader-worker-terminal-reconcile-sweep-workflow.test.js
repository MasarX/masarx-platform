const fs = require('fs');
const path = require('path');

describe('leader-worker-terminal-reconcile-sweep workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'leader-worker-terminal-reconcile-sweep.yml',
  );

  test('runs only by manual dispatch and reconciles closed worker-plan issues to terminal done', () => {
    const body = fs.readFileSync(workflowFile, 'utf8').replace(/\r\n/g, '\n');

    expect(body).toContain('workflow_dispatch:');
    expect(body).not.toContain('\n  schedule:\n');
    expect(body).toContain("state: 'closed'");
    expect(body).toContain("labels: ASSIGNMENT_KIND_LABEL");
    expect(body).toContain('normalizeAssignmentToDone');
    expect(body).toContain('closeIfOpen: true');
    expect(body).toContain('Previous Dispatch Labels:');
    expect(body).toContain('Result: normalized to `dispatch:done` and assignees cleared when present.');
    expect(body).toContain('LEADER_TERMINAL_RECONCILE_MAX_ISSUES');
  });
});
