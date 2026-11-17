const {
  parseArgs,
  parseTargets,
  selectWorkflowRunCandidate,
  computeAggregateConclusion,
  waitForChildrenRuns,
} = require('../../../scripts/ops/ci/orchestrator-wait-children');

describe('orchestrator-wait-children', () => {
  test('parseArgs handles long-form inputs', () => {
    const parsed = parseArgs([
      '--stage',
      'stg',
      '--sha=abc123',
      '--targets-json',
      '[{"surface_id":"console","workflow_id":"deploy-console.yml"}]',
      '--started-at',
      '2026-02-24T00:00:00Z',
      '--timeout-minutes',
      '45',
      '--poll-seconds=10',
      '--summary-path',
      '.tmp/summary.json',
      '--format',
      'github-output',
      '--wait-for-children',
      '1',
    ]);
    expect(parsed.stage).toBe('stg');
    expect(parsed.sha).toBe('abc123');
    expect(parsed.targetsJson).toContain('surface_id');
    expect(parsed.startedAt).toBe('2026-02-24T00:00:00Z');
    expect(parsed.timeoutMinutes).toBe('45');
    expect(parsed.pollSeconds).toBe('10');
    expect(parsed.summaryPath).toBe('.tmp/summary.json');
    expect(parsed.format).toBe('github-output');
    expect(parsed.waitForChildren).toBe('1');
  });

  test('parseTargets returns normalized target list', () => {
    const targets = parseTargets(
      '[{"surface_id":"console","workflow_id":"deploy-console.yml"},{"surface_id":"portal","workflow_id":"deploy-portal.yml"}]',
    );
    expect(targets).toEqual([
      { surface_id: 'console', workflow_id: 'deploy-console.yml' },
      { surface_id: 'portal', workflow_id: 'deploy-portal.yml' },
    ]);
  });

  test('selectWorkflowRunCandidate picks newest run for same sha after orchestrator start', () => {
    const startedAtMs = Date.parse('2026-02-24T10:00:00Z');
    const runs = [
      {
        id: 11,
        head_sha: 'abc123',
        created_at: '2026-02-24T09:30:00Z',
      },
      {
        id: 22,
        head_sha: 'abc123',
        created_at: '2026-02-24T10:03:00Z',
      },
      {
        id: 33,
        head_sha: 'abc123',
        created_at: '2026-02-24T10:05:00Z',
      },
      {
        id: 44,
        head_sha: 'def456',
        created_at: '2026-02-24T10:06:00Z',
      },
    ];
    const selected = selectWorkflowRunCandidate({
      runs,
      sha: 'abc123',
      startedAtMs,
      pinnedRunId: '',
    });
    expect(selected.id).toBe(33);
  });

  test('selectWorkflowRunCandidate honors pinned run id when present', () => {
    const runs = [
      { id: 77, head_sha: 'abc123', created_at: '2026-02-24T10:03:00Z' },
      { id: 88, head_sha: 'abc123', created_at: '2026-02-24T10:05:00Z' },
    ];
    const selected = selectWorkflowRunCandidate({
      runs,
      sha: 'abc123',
      startedAtMs: Date.parse('2026-02-24T10:00:00Z'),
      pinnedRunId: '77',
    });
    expect(selected.id).toBe(77);
  });

  test('selectWorkflowRunCandidate falls back to the newest same-sha run for failed-job reruns', () => {
    const runs = [
      { id: 77, head_sha: 'abc123', status: 'completed', conclusion: 'success', created_at: '2026-02-24T10:03:00Z' },
      { id: 88, head_sha: 'abc123', status: 'completed', conclusion: 'cancelled', created_at: '2026-02-24T10:05:00Z' },
      { id: 99, head_sha: 'def456', created_at: '2026-02-24T10:06:00Z' },
    ];
    const selected = selectWorkflowRunCandidate({
      runs,
      sha: 'abc123',
      startedAtMs: Date.parse('2026-02-24T11:00:00Z'),
      pinnedRunId: '',
    });
    expect(selected.id).toBe(77);
  });

  test('selectWorkflowRunCandidate prefers an in-progress same-sha run over an older success', () => {
    const runs = [
      { id: 77, head_sha: 'abc123', status: 'completed', conclusion: 'success', created_at: '2026-02-24T10:03:00Z' },
      { id: 88, head_sha: 'abc123', status: 'in_progress', conclusion: '', created_at: '2026-02-24T10:05:00Z' },
    ];
    const selected = selectWorkflowRunCandidate({
      runs,
      sha: 'abc123',
      startedAtMs: Date.parse('2026-02-24T10:00:00Z'),
      pinnedRunId: '',
    });
    expect(selected.id).toBe(88);
  });

  test('computeAggregateConclusion fails when any child is non-success', () => {
    const conclusion = computeAggregateConclusion([
      { surface_id: 'console', conclusion: 'success' },
      { surface_id: 'portal', conclusion: 'failure' },
    ]);
    expect(conclusion).toBe('failure');
  });

  test('computeAggregateConclusion is success when all children succeed', () => {
    const conclusion = computeAggregateConclusion([
      { surface_id: 'console', conclusion: 'success' },
      { surface_id: 'portal', conclusion: 'success' },
    ]);
    expect(conclusion).toBe('success');
  });

  test('exports wait helper and avoids wait function shadowing', () => {
    expect(typeof waitForChildrenRuns).toBe('function');
    const fs = require('fs');
    const path = require('path');
    const file = path.join(__dirname, '..', '..', '..', 'scripts', 'ops', 'ci', 'orchestrator-wait-children.js');
    const body = fs.readFileSync(file, 'utf8');
    expect(body).toContain('const shouldWaitForChildren = parseBool01(');
    expect(body).not.toContain('const waitForChildren = parseBool01(');
  });

  test('waitForChildrenRuns tolerates a transient workflow-list fetch failure and succeeds on a later poll', async () => {
    const listWorkflowRunsImpl = jest
      .fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockResolvedValueOnce([
        {
          id: 101,
          html_url: 'https://github.com/MasarX/MasarX/actions/runs/101',
          head_sha: 'abc123',
          status: 'in_progress',
          conclusion: '',
          created_at: '2026-02-24T10:03:00Z',
        },
      ])
      .mockResolvedValueOnce([
        {
          id: 101,
          html_url: 'https://github.com/MasarX/MasarX/actions/runs/101',
          head_sha: 'abc123',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-02-24T10:03:00Z',
        },
      ]);
    let nowMs = Date.parse('2026-02-24T10:00:00Z');
    const sleepImpl = async (ms) => {
      nowMs += ms;
    };
    const warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const summary = await waitForChildrenRuns({
      stage: 'dev',
      sha: 'abc123',
      targets: [{ surface_id: 'db', workflow_id: 'deploy-dev.yml' }],
      startedAt: '2026-02-24T10:00:00Z',
      timeoutMinutes: 1,
      pollSeconds: 5,
      token: 'test-token',
      owner: 'MasarX',
      repo: 'MasarX',
      listWorkflowRunsImpl,
      sleepImpl,
      nowImpl: () => nowMs,
    });

    expect(summary.aggregate_conclusion).toBe('success');
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0]).toMatchObject({
      surface_id: 'db',
      workflow_id: 'deploy-dev.yml',
      run_id: '101',
      run_status: 'completed',
      conclusion: 'success',
    });
    expect(summary.targets[0].fetch_error_count).toBe(1);
    expect(summary.targets[0].last_error).toContain('fetch failed');
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('transient GitHub API failure for workflow=deploy-dev.yml surface=db: fetch failed'),
    );
    warnSpy.mockRestore();
  });

  test('waitForChildrenRuns reuses a prior successful same-sha child run on a failed-job rerun', async () => {
    const listWorkflowRunsImpl = jest
      .fn()
      .mockResolvedValueOnce([
        {
          id: 77,
          html_url: 'https://github.com/MasarX/MasarX/actions/runs/77',
          head_sha: 'abc123',
          status: 'completed',
          conclusion: 'success',
          created_at: '2026-02-24T10:03:00Z',
        },
        {
          id: 88,
          html_url: 'https://github.com/MasarX/MasarX/actions/runs/88',
          head_sha: 'abc123',
          status: 'completed',
          conclusion: 'cancelled',
          created_at: '2026-02-24T10:05:00Z',
        },
      ]);

    const summary = await waitForChildrenRuns({
      stage: 'dev',
      sha: 'abc123',
      targets: [{ surface_id: 'db', workflow_id: 'deploy-dev.yml' }],
      startedAt: '2026-02-24T11:00:00Z',
      timeoutMinutes: 1,
      pollSeconds: 5,
      token: 'test-token',
      owner: 'MasarX',
      repo: 'MasarX',
      listWorkflowRunsImpl,
      sleepImpl: async () => {},
      nowImpl: () => Date.parse('2026-02-24T11:00:00Z'),
    });

    expect(summary.aggregate_conclusion).toBe('success');
    expect(summary.targets).toHaveLength(1);
    expect(summary.targets[0]).toMatchObject({
      surface_id: 'db',
      workflow_id: 'deploy-dev.yml',
      run_id: '77',
      run_status: 'completed',
      conclusion: 'success',
    });
  });
});
