const fs = require('fs');
const path = require('path');

const guardRequiredWorkflowFiles = [
  'deploy-prod.yml',
  'deploy-landing-prod.yml',
  'publish-public-docs.yml',
  'deploy-console.yml',
  'deploy-portal.yml',
  'deploy-api-ingress-worker.yml',
  'deploy-mobile-fieldops.yml',
];

const autoStgWorkflowFiles = [
  'deploy-stg-promote.yml',
  'deploy-landing-stg.yml',
];

function readWorkflow(workflowFile) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '.github', 'workflows', workflowFile),
    'utf8',
  );
}

describe('skip_approval guard wiring in deploy workflows', () => {
  test.each(guardRequiredWorkflowFiles)('%s includes centralized skip_approval guard job', (workflowFile) => {
    const body = readWorkflow(workflowFile);
    expect(body).toContain('skip_approval_guard:');
    expect(body).toContain('Guard skip_approval policy');
    expect(body).toContain('filter: blob:none');
    expect(body).toContain('sparse-checkout: |');
    expect(body).toContain('scripts/ops/ci/skip-approval-guard.js');
    expect(body).toContain('node scripts/ops/ci/skip-approval-guard.js --format github-output');
    expect(body).toContain("SKIP_APPROVAL_ALLOWED_ACTORS: ${{ vars.DEPLOY_SKIP_APPROVAL_ALLOWED_ACTORS || '' }}");
  });

  test.each(guardRequiredWorkflowFiles)('%s removed direct manual skip_approval bypass expressions', (workflowFile) => {
    const body = readWorkflow(workflowFile);
    expect(body).not.toContain("github.event_name == 'workflow_dispatch' && inputs.skip_approval");
    expect(body).not.toContain('&& !inputs.skip_approval');
  });

  test.each(guardRequiredWorkflowFiles)('%s enforces guard success before deploy/publish steps', (workflowFile) => {
    const body = readWorkflow(workflowFile);
    expect(body).toContain("needs.skip_approval_guard.result == 'success'");
  });

  test.each(autoStgWorkflowFiles)('%s does not wire skip_approval guard in auto-stg mode', (workflowFile) => {
    const body = readWorkflow(workflowFile);
    expect(body).not.toContain('skip_approval_guard:');
    expect(body).not.toContain('Guard skip_approval policy');
    expect(body).not.toContain('node scripts/ops/ci/skip-approval-guard.js --format github-output');
    expect(body).not.toContain("needs.skip_approval_guard.result == 'success'");
  });
});
