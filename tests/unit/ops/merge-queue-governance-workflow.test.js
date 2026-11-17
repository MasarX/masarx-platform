const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('merge-queue-governance workflow', () => {
  test('triggers from PR Gate merge-group completions and manual dispatch', () => {
    const body = readWorkflow('merge-queue-governance.yml');
    expect(body).toContain('workflow_run:');
    expect(body).toContain('PR Gate (Preview + Verify)');
    expect(body).toContain('types: [completed]');
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('run_id:');
    expect(body).toContain('dry_run:');
  });

  test('uses pinned actions and governance helpers for auto-hold recovery', () => {
    const body = readWorkflow('merge-queue-governance.yml');
    expect(body).toContain('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
    expect(body).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(body).toContain("AUTOMERGE_AUTO_HOLD_LABEL || 'queue:auto-held'");
    expect(body).toContain('runMergeQueueGovernance');
    expect(body).toContain('disableAutoMerge');
    expect(body).toContain('removeLabel');
  });
});
