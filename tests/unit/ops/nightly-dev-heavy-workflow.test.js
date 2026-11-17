const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('nightly-dev-heavy workflow', () => {
  test('runs on schedule plus manual dispatch and keeps a singleton concurrency group per ref', () => {
    const body = readWorkflow('nightly-dev-heavy.yml');

    expect(body).toContain('schedule:');
    expect(body).toContain("cron: '30 1 * * *'");
    expect(body).toContain('workflow_dispatch:');
    expect(body).toContain('ref:');
    expect(body).toContain("group: nightly-dev-heavy-${{ github.event_name == 'workflow_dispatch' && github.event.inputs.ref || 'dev' }}");
    expect(body).toContain('cancel-in-progress: false');
  });

  test('runs broad heavy core, ui, landing, and mobile jobs through reusable cloud-run lanes', () => {
    const body = readWorkflow('nightly-dev-heavy.yml');

    expect(body).toContain('Nightly Dev Heavy / Core');
    expect(body).toContain('Nightly Dev Heavy / UI');
    expect(body).toContain('Nightly Dev Heavy / Landing');
    expect(body).toContain('Nightly Dev Heavy / Mobile');
    expect((body.match(/uses: \.\/\.github\/workflows\/cloud-run\.yml/g) || []).length).toBe(4);
    expect(body).toContain('runner_class_id: ci_deploy_shared');
    expect(body).toContain('runner_class_id: ci_playwright');
    expect(body).toContain('concurrency_group: nightly-dev-heavy-${{ github.run_id }}-core');
    expect(body).toContain('concurrency_group: nightly-dev-heavy-${{ github.run_id }}-ui');
    expect(body).toContain('concurrency_group: nightly-dev-heavy-${{ github.run_id }}-landing');
    expect(body).toContain('concurrency_group: nightly-dev-heavy-${{ github.run_id }}-mobile');
    expect(body).toContain('npm run verify:cloud:core');
    expect(body).toContain('E2E_PROFILE=full');
    expect(body).toContain('npm run verify:cloud:ui');
    expect(body).toContain('LANDING_BASE_URL="${LANDING_BASE_URL:-${LANDING_SITE_URL:-}}"');
    expect(body).toContain('playwright.landing.config.ts');
    expect(body).toContain('MOBILE_STRICT_SUMMARY_OUT=tmp/nightly-dev-heavy-mobile-summary.json');
    expect(body).toContain('npm run verify:mobile:fieldops:strict');
  });

  test('publishes a machine-readable summary artifact and refreshes the tracked nightly regression issue', () => {
    const body = readWorkflow('nightly-dev-heavy.yml');

    expect(body).toContain('Nightly Dev Heavy / Summary');
    expect(body).toContain('nightly-dev-heavy-summary.js');
    expect(body).toContain('nightly-dev-heavy-summary.json');
    expect(body).toContain('nightly-dev-heavy-summary.md');
    expect(body).toContain('Upload nightly summary artifact');
    expect(body).toContain('continue-on-error: true');
    expect(body).toContain('Refresh nightly regression issue');
    expect(body).toContain('GENERATED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"');
    expect(body).toContain('export GENERATED_AT');
    expect(body).not.toContain('github.run_started_at');
    expect(body).toContain('collectNightlyRegressionHistory');
    expect(body).toContain('upsertNightlyRegressionIssue');
    expect(body).toContain("NIGHTLY_REGRESSION_ISSUE_LABEL: ${{ vars.NIGHTLY_REGRESSION_ISSUE_LABEL || 'ops:nightly-regression' }}");
  });
});
