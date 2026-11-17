const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('stale-bot-pr-governance workflow', () => {
  test('runs on schedule and workflow_dispatch with write permissions', () => {
    const body = readWorkflow('stale-bot-pr-governance.yml');
    expect(body).toContain('schedule:');
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('checks: read');
    expect(body).toContain('statuses: read');
    expect(body).toContain('issues: write');
    expect(body).toContain('pull-requests: write');
  });

  test('uses pinned actions and the stale bot governance script/config', () => {
    const body = readWorkflow('stale-bot-pr-governance.yml');
    expect(body).toContain('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
    expect(body).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(body).toContain('loadPolicyConfig');
    expect(body).toContain('runStaleBotPrGovernance');
    expect(body).toContain("BOT_PR_PRESERVE_LABEL || 'bot:preserve'");
  });
});
