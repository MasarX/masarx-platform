const fs = require('fs');
const path = require('path');

describe('leader-worker-claim workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'leader-worker-claim.yml',
  );

  test('supports execution cards while still failing closed for retired legacy worker-plan cards', () => {
    const body = fs.readFileSync(workflowFile, 'utf8').replace(/\r\n/g, '\n');

    expect(body).toContain('group: leader-worker-claim-${{ github.event.issue.number || github.run_id }}');
    expect(body).toContain('cancel-in-progress: false');
    expect(body).toContain('EXECUTION_CARD_KIND_LABEL');
    expect(body).toContain('const isExecutionCard = labels.includes(EXECUTION_CARD_KIND_LABEL);');
    expect(body).toContain('const isLegacyWorkerPlan = labels.includes(ASSIGNMENT_KIND_LABEL);');
    expect(body).toContain('if (!isExecutionCard && !isLegacyWorkerPlan) {');
    expect(body).toContain('if (isLegacyWorkerPlan && !isExecutionCard) {');
    expect(body).toContain('const kindLabel = isExecutionCard ? EXECUTION_CARD_KIND_LABEL : ASSIGNMENT_KIND_LABEL;');
    expect(body).toContain('kindLabel,');
    expect(body).toContain('legacy `kind:worker-plan` assignment cards are retired');
    expect(body).toContain('project-first Planning OS');
    expect(body).toContain('npm run ops:planning-os:help');
    expect(body).toContain('core.setFailed(');
  });
});
