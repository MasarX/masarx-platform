const fs = require('fs');
const path = require('path');

describe('merge-queue-status-bridge workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'merge-queue-status-bridge.yml',
  );

  test('runs on merge_group with statuses write permission', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain('name: Merge Queue Status Bridge');
    expect(body).toContain('merge_group:');
    expect(body).toContain('types: [checks_requested]');
    expect(body).toContain('RUNNER_LABELS_CI_PR_ADMISSION_JSON');
    expect(body).toContain('ENTERPRISE_RUNNER_MODE');
    expect(body).toContain('ENTERPRISE_RUNNER_BREAKGLASS');
    expect(body).toContain('timeout-minutes: 8');
    expect(body).toContain('checks: read');
    expect(body).toContain('pull-requests: read');
    expect(body).toContain('statuses: write');
    expect(body).toContain('merge_queue_status_bridge:');
  });

  test('uses sparse checkout for scripts-only bridge publishing', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain('fetch-depth: 1');
    expect(body).toContain('filter: blob:none');
    expect(body).toContain('sparse-checkout: |');
    expect(body).toContain('scripts');
    expect(body).toContain('config');
  });

  test('uses configurable bridge controls via repository vars', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    expect(body).toContain("MERGE_QUEUE_STATUS_BRIDGE_ENABLED: ${{ vars.MERGE_QUEUE_STATUS_BRIDGE_ENABLED || '1' }}");
    expect(body).toContain("MERGE_QUEUE_STATUS_BRIDGE_CONTEXTS: ${{ vars.MERGE_QUEUE_STATUS_BRIDGE_CONTEXTS || 'plan_check,control_plane_review_gate,agent_review_gate,dev_quality / run,security_scan,objectives_lint_changed / run' }}");
    expect(body).toContain("MERGE_QUEUE_STATUS_BRIDGE_DESCRIPTION: ${{ vars.MERGE_QUEUE_STATUS_BRIDGE_DESCRIPTION || 'Bridged PR-side required checks for merge queue.' }}");
    expect(body).toContain("MERGE_QUEUE_STATUS_BRIDGE_MAX_WAIT_MS: ${{ vars.MERGE_QUEUE_STATUS_BRIDGE_MAX_WAIT_MS || '180000' }}");
    expect(body).toContain("MERGE_QUEUE_STATUS_BRIDGE_RETRY_DELAY_MS: ${{ vars.MERGE_QUEUE_STATUS_BRIDGE_RETRY_DELAY_MS || '5000' }}");
    expect(body).toContain('node scripts/ops/ci/merge-queue-status-bridge.js');
  });
});

