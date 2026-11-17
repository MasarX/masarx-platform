const fs = require('fs');
const path = require('path');

function readWorkflow(name) {
  return fs.readFileSync(path.join(__dirname, '..', '..', '..', '.github', 'workflows', name), 'utf8');
}

describe('ready-pr-automerge workflow', () => {
  test('reacts to hold-label changes, required workflow completions, and a 15-minute sweep', () => {
    const body = readWorkflow('ready-pr-automerge.yml');
    expect(body).toContain('schedule:');
    expect(body).toContain("cron: '*/15 * * * *'");
    expect(body).toContain('pull_request_target:');
    expect(body).toContain('workflow_run:');
    expect(body).toContain("if: ${{ github.event_name != 'workflow_run' || github.event.workflow_run.conclusion == 'success' || github.event.workflow_run.conclusion == 'neutral' || github.event.workflow_run.conclusion == 'skipped' }}");
    expect(body).toContain('PR Gate (Preview + Verify)');
    expect(body).toContain('PR Governance Gate');
    expect(body).toContain('Control Plane Review Gate');
    expect(body).toContain('Security Scan Gates');
    expect(body).toContain('Debounce workflow_run bursts');
    expect(body).toContain('Fast-skip empty scheduled sweep');
    expect(body).toContain("base: 'dev'");
    expect(body).toContain('No open same-repo PRs targeting dev; skipping scheduled sweep before checkout.');
    expect(body).toContain("READY_PR_AUTOMERGE_DEBOUNCE_SECONDS || '45'");
    expect(body).not.toContain('PR Plan Check');
    expect(body).not.toContain('Agent Review Gate');
  });

  test('uses pinned actions and the shared auto-merge helper', () => {
    const body = readWorkflow('ready-pr-automerge.yml');
    expect(body).toContain('actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd');
    expect(body).toContain('./.github/actions/mint-automation-token');
    expect(body).toContain("EXAMPLE_PASSWORD: ${{ secrets.PLAN_AUTOMATION_PR_TOKEN || github.token }}");
    expect(body).toContain('actions/github-script@ed597411d8f924073f98dfc5c65a23a2325f34cd');
    expect(body).toContain('checks: read');
    expect(body).toContain('statuses: read');
    expect(body).toContain('github-token: ${{ steps.token.outputs.token || github.token }}');
    expect(body).toContain('READ_GITHUB_TOKEN: ${{ steps.token.outputs.token || github.token }}');
    expect(body).toContain('STATUS_GITHUB_TOKEN: ${{ github.token }}');
    expect(body).toContain('const readGithub = process.env.READ_GITHUB_TOKEN');
    expect(body).toContain('new github.constructor({ auth: process.env.READ_GITHUB_TOKEN })');
    expect(body).toContain('const statusGithub = process.env.STATUS_GITHUB_TOKEN');
    expect(body).toContain('new github.constructor({ auth: process.env.STATUS_GITHUB_TOKEN })');
    expect(body).toContain("AUTOMERGE_HOLD_LABEL || 'automerge:hold'");
    expect(body).toContain("AUTOMERGE_AUTO_HOLD_LABEL || 'queue:auto-held'");
    expect(body).toContain('scan_all:');
    expect(body).toContain('fetchOpenPullRequestNumbers');
    expect(body).toContain('runReadyPrAutomerge');
    expect(body).toContain('enableAutoMerge');
    expect(body).toContain('enqueuePullRequest');
    expect(body).not.toContain("workflow_id: 'runner-group-drift-sweep.yml'");
    expect(body).not.toContain('createWorkflowDispatch');
    expect(body).not.toContain('Dispatched Enterprise Runner Group Drift Sweep on');
    expect(body).toContain('readGithub,');
    expect(body).toContain('statusGithub,');
    expect(body).toContain('removeLabel');
    expect(body).toContain('github.event.workflow_run.pull_requests[0].number');
    expect(body).toContain('inputs.pr_number');
    expect(body).toContain('github.event.workflow_run.head_sha');
    expect(body).toContain("github.event_name != 'schedule' || steps.scheduled_precheck.outputs.should_skip != 'true'");
    expect(body).toContain('cancel-in-progress: true');
    expect(body).not.toContain('resolve_control_plane_runner:');
    expect(body).not.toContain('resolve-linux-runner.yml@v1');
    expect(body).toContain('runs-on: ${{ fromJSON(((vars.RUNNER_RUNS_ON_LINUX_LOCAL_JSON != \'\'');
    expect(body).toContain('vars.RUNNER_RUNS_ON_LINUX_LOCAL_JSON');
  });
});
