const {
  buildValidationNotes,
  normalizeShortText,
  parseArgs,
  suggestedArtifactName,
} = require('../../../scripts/ops/ci/reviewer-gate-execution-evidence');

describe('reviewer-gate execution evidence helpers', () => {
  test('parses project sync and artifact options', () => {
    expect(parseArgs([
      '--format', 'github-output',
      '--artifact-path', 'artifacts/ci/custom.json',
      '--execution-anchor', 'Spec-Issue #2583',
      '--execution-anchor-slug', 'spec-issue-2583',
      '--spec-issue', '#2583',
      '--assignment-issue', '#2584',
      '--step', 'E01',
      '--project-number', '6',
      '--sync-project-validation-notes',
    ])).toMatchObject({
      format: 'github-output',
      artifactPath: 'artifacts/ci/custom.json',
      executionAnchor: 'Spec-Issue #2583',
      executionAnchorSlug: 'spec-issue-2583',
      specIssue: '#2583',
      assignmentIssue: '#2584',
      step: 'E01',
      projectNumber: '6',
      syncProjectValidationNotes: true,
    });
  });

  test('builds stable artifact names from execution anchors', () => {
    expect(suggestedArtifactName('Spec-Issue 2583 / Preview')).toBe(
      'reviewer-gate-evidence-spec-issue-2583-preview',
    );
  });

  test('validation notes stay compact and project-safe', () => {
    const notes = buildValidationNotes({
      executionAnchor: 'Spec-Issue #2583',
      step: 'E01',
      testsGate: 'passed',
      runUrl: 'https://github.com/MasarX/MasarX/actions/runs/24238637037',
      artifactName: 'reviewer-gate-evidence-spec-issue-2583',
      validatedAt: '2026-04-10T10:30:57Z',
    });

    expect(notes).toContain('Reviewer gate passed');
    expect(notes).toContain('anchor=Spec-Issue #2583');
    expect(notes).toContain('step=E01');
    expect(notes).toContain('artifact=reviewer-gate-evidence-spec-issue-2583');
    expect(notes.length).toBeLessThanOrEqual(240);
    expect(notes).toBe(normalizeShortText(notes));
  });
});
