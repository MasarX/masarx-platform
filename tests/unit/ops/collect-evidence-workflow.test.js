const fs = require('fs');
const path = require('path');
const yaml = require('yaml');

describe('collect-evidence workflow', () => {
  const workflowFile = path.join(
    __dirname,
    '..',
    '..',
    '..',
    '.github',
    'workflows',
    'collect-evidence.yml',
  );

  test('archives the full onboarding release proof set', () => {
    const body = fs.readFileSync(workflowFile, 'utf8');
    const parsed = yaml.parse(body);

    expect(parsed.name).toBe('Collect Evidence');
    expect(parsed.on).toHaveProperty('workflow_run');
    expect(parsed.on.workflow_run).toHaveProperty('workflows');
    expect(parsed.on.workflow_run.workflows).toEqual(
      expect.arrayContaining([
        'Verify (DB + Tests)',
        'Verify UI (Stg)',
        'Weekly Load Test',
        'Deploy Mobile FieldOps (Manual)',
      ]),
    );
    expect(body).toContain('Mint automation token (GitHub App required)');
    expect(body).toContain('git remote set-url origin "https://x-access-token:${{ steps.token.outputs.token }}@github.com/${{ github.repository }}.git"');
  });
});
