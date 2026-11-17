const fs = require('fs');
const path = require('path');

function readWorkflow(fileName) {
  return fs.readFileSync(
    path.join(__dirname, '..', '..', '..', '.github', 'workflows', fileName),
    'utf8',
  );
}

describe('merge-queue workflow concurrency contracts', () => {
  test('reviewer gate collapses PR reruns by PR identity and isolates merge-group heads', () => {
    const body = readWorkflow('reviewer-gate-pr.yml');
    expect(body).toContain(
      "group: reviewer-gate-pr-${{ github.event_name }}-${{ github.event.pull_request.number || github.event.inputs.pr_number || github.event.merge_group.head_sha || github.sha || github.ref || github.run_id }}",
    );
    expect(body).toContain("cancel-in-progress: ${{ github.event_name != 'merge_group' }}");
  });

  test('pr governance gate keeps workflow-dispatch reruns out of the required PR concurrency lane', () => {
    const body = readWorkflow('pr-governance-gate.yml');
    expect(body).toContain(
      "group: pr-governance-gate-${{ github.event_name }}-${{ (github.event_name == 'pull_request' && (github.event.action == 'labeled' || github.event.action == 'unlabeled' || github.event.action == 'edited')) && github.event.action || 'primary' }}-${{ github.event.pull_request.number || github.event.inputs.pr_number || github.ref || github.run_id }}",
    );
    expect(body).toContain("cancel-in-progress: ${{ github.event_name != 'pull_request' || (github.event.action != 'labeled' && github.event.action != 'unlabeled' && github.event.action != 'edited') }}");
  });

  test('merge queue bridge never cancels an in-flight merge-group run', () => {
    const body = readWorkflow('merge-queue-status-bridge.yml');
    expect(body).toContain('group: merge-queue-status-bridge-${{ github.ref }}');
    expect(body).toContain('cancel-in-progress: false');
  });

  test('main ruleset workflows isolate merge-group concurrency from pull_request churn', () => {
    const cases = [
      [
        'plan-require-complete.yml',
        "group: plan-require-complete-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref || github.run_id }}",
      ],
      [
        'release-policy-main.yml',
        "group: release-policy-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref || github.run_id }}",
      ],
      [
        'release-verify-main.yml',
        "group: release-verify-${{ github.event_name }}-${{ github.event.pull_request.number || github.ref || github.run_id }}",
      ],
    ];

    for (const [fileName, groupLine] of cases) {
      const body = readWorkflow(fileName);
      expect(body).toContain(groupLine);
      expect(body).toContain("cancel-in-progress: ${{ github.event_name != 'merge_group' }}");
    }
  });
});
