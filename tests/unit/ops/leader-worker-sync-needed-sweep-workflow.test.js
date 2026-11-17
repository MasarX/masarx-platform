const fs = require('fs');
const path = require('path');

describe('leader-worker-sync-needed-sweep workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'leader-worker-sync-needed-sweep.yml',
  );

  test('runs only by manual dispatch and scans sync-needed assignment issues', () => {
    const body = fs.readFileSync(workflowFile, 'utf8').replace(/\r\n/g, '\n');

    expect(body).toContain('workflow_dispatch:');
    expect(body).not.toContain('\n  schedule:\n');
    expect(body).toContain('labels: `${ASSIGNMENT_KIND_LABEL},dispatch:sync-needed`');
    expect(body).toContain('Contract validation passed; cleared sync-needed state.');
    expect(body).toContain('normalizeAssignmentToDone');
    expect(body).toContain('Terminalization: archived canonical plan (status:');
    expect(body).toContain('normalized assignment to \\`dispatch:done\\`.');
    expect(body).toContain('Missing `Review Policy: required|optional` in issue body.');
    expect(body).toContain('Missing or placeholder `Plan Snapshot:` in issue body.');
    expect(body).toContain("(/^<[^>\\n]+>$/.test(raw) && !raw.startsWith('<!--'))");
    expect(body).not.toContain("v.startsWith('<')");
  });
});
