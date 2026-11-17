const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('automation workflows app-only auth contract', () => {
  test('collect-evidence is fail-closed on missing app token', () => {
    const body = readWorkflow('collect-evidence.yml');
    expect(body).toContain('Mint automation token (GitHub App required)');
    expect(body).toContain('uses: ./.github/actions/mint-automation-token');
    expect(body).not.toContain('continue-on-error: true');
    expect(body).not.toContain('Missing automation token; collect-evidence push will be skipped.');
    expect(body).toContain('git remote set-url origin "https://x-access-token:${{ steps.token.outputs.token }}@github.com/${{ github.repository }}.git"');
    expect(body).toContain('GH_TOKEN: ${{ steps.token.outputs.token }}');
    expect(body).not.toContain('Push skipped (missing automation token)');
  });

  test('evidence-retention is fail-closed on missing app token', () => {
    const body = readWorkflow('evidence-retention.yml');
    expect(body).toContain('Mint automation token (GitHub App required)');
    expect(body).toContain('uses: ./.github/actions/mint-automation-token');
    expect(body).not.toContain('continue-on-error: true');
    expect(body).not.toContain('Missing automation token; evidence-retention push will be skipped.');
    expect(body).toContain('git remote set-url origin "https://x-access-token:${{ steps.token.outputs.token }}@github.com/${{ github.repository }}.git"');
    expect(body).not.toContain('Push skipped (missing automation token)');
  });

  test('automation-branch-retention is fail-closed on missing app token', () => {
    const body = readWorkflow('automation-branch-retention.yml');
    expect(body).toContain('Mint automation token (GitHub App required)');
    expect(body).toContain('uses: ./.github/actions/mint-automation-token');
    expect(body).not.toContain('continue-on-error: true');
    expect(body).not.toContain('Missing automation token; skipping automation branch retention.');
    expect(body).toContain('github-token: ${{ steps.token.outputs.token }}');
  });
});
