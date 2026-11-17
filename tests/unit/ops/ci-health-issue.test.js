const {
  ISSUE_MARKER,
  buildPolicy,
  buildIssueTitle,
  buildIssueBody,
  closeExistingIssueIfHealthy,
  upsertCiHealthIssue,
} = require('../../../scripts/ops/ci/ci-health-issue');

describe('ci-health-issue', () => {
  test('buildPolicy uses enabled label defaults', () => {
    const policy = buildPolicy({
      CI_HEALTH_ISSUE_ENABLED: '1',
      CI_HEALTH_ISSUE_LABEL: 'ops:ci-health',
    });

    expect(policy.enabled).toBe(true);
    expect(policy.label).toBe('ops:ci-health');
    expect(policy.marker).toBe(ISSUE_MARKER);
  });

  test('buildIssueBody renders threshold violations and queue rows', () => {
    const body = buildIssueBody({
      queueHealth: {
        repo: 'MasarX/MasarX',
        generated_at: '2026-03-08T18:00:00Z',
        target_base: 'dev',
        ready_but_not_enqueued_total: 1,
        autoheld_total: 1,
        non_code_github_api_failures_total: 0,
        ready_but_not_enqueued: [{ pr_number: 1773, wait_seconds: 3600, author: 'alice' }],
        autoheld_prs: [{ pr_number: 1785, failure_count: 2, hold_reason: 'merge_group_failures', last_failed_step: 'reviewer_gate :: Core verify (preview)' }],
        top_queue_burners: [{ pr_number: 1785, failed_runs: 2, wasted_duration_seconds: 2400 }],
        thresholds: {
          open_issue: true,
          violations: [{ message: '1 ready PR exceeded the queue wait threshold.' }],
        },
      },
    });

    expect(body).toContain(ISSUE_MARKER);
    expect(body).toContain('CI Health Regression');
    expect(body).toContain('1 ready PR exceeded the queue wait threshold.');
    expect(body).toContain('#1773');
    expect(body).toContain('#1785');
  });

  test('upsertCiHealthIssue updates an existing tracked issue instead of creating duplicates', async () => {
    const github = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 99,
          body: `${ISSUE_MARKER}\nexisting`,
          labels: [{ name: 'ops:ci-health' }],
        },
      ]),
      rest: {
        issues: {
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockResolvedValue({ data: { number: 100 } }),
        },
      },
    };
    const ensureLabel = jest.fn().mockResolvedValue({});

    const result = await upsertCiHealthIssue({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      queueHealth: {
        repo: 'MasarX/MasarX',
        target_base: 'dev',
        thresholds: {
          open_issue: true,
          violations: [{ message: 'merge queue unhealthy' }],
        },
      },
      policy: buildPolicy({ CI_HEALTH_ISSUE_ENABLED: '1', CI_HEALTH_ISSUE_LABEL: 'ops:ci-health' }),
      helpers: { ensureLabel },
    });

    expect(result).toEqual({ action: 'updated', issueNumber: 99 });
    expect(ensureLabel).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.create).not.toHaveBeenCalled();
  });

  test('upsertCiHealthIssue skips when thresholds are healthy', async () => {
    const result = await upsertCiHealthIssue({
      github: {},
      owner: 'MasarX',
      repo: 'MasarX',
      queueHealth: {
        repo: 'MasarX/MasarX',
        target_base: 'dev',
        thresholds: {
          open_issue: false,
          violations: [],
        },
      },
      policy: buildPolicy({ CI_HEALTH_ISSUE_ENABLED: '1' }),
    });

    expect(result).toEqual({ action: 'skip', reason: 'healthy' });
  });

  test('closeExistingIssueIfHealthy closes the tracked issue and refreshes the body', async () => {
    const github = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 101,
          body: `${ISSUE_MARKER}\nexisting`,
          labels: [{ name: 'ops:ci-health' }],
        },
      ]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
        },
      },
    };

    const result = await closeExistingIssueIfHealthy({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      policy: buildPolicy({ CI_HEALTH_ISSUE_ENABLED: '1', CI_HEALTH_ISSUE_LABEL: 'ops:ci-health' }),
      queueHealth: {
        repo: 'MasarX/MasarX',
        generated_at: '2026-03-16T14:28:29Z',
        target_base: 'dev',
        thresholds: {
          open_issue: false,
          violations: [],
        },
      },
    });

    expect(result).toEqual({ action: 'closed', issueNumber: 101 });
    expect(github.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        owner: 'MasarX',
        repo: 'MasarX',
        issue_number: 101,
        state: 'closed',
      }),
    );
  });

  test('upsertCiHealthIssue closes an existing tracked issue when thresholds recover', async () => {
    const github = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 102,
          body: `${ISSUE_MARKER}\nexisting`,
          labels: [{ name: 'ops:ci-health' }],
        },
      ]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockResolvedValue({ data: { number: 103 } }),
        },
      },
    };

    const result = await upsertCiHealthIssue({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      queueHealth: {
        repo: 'MasarX/MasarX',
        target_base: 'dev',
        thresholds: {
          open_issue: false,
          violations: [],
        },
      },
      policy: buildPolicy({ CI_HEALTH_ISSUE_ENABLED: '1', CI_HEALTH_ISSUE_LABEL: 'ops:ci-health' }),
    });

    expect(result).toEqual({ action: 'closed', issueNumber: 102 });
    expect(github.rest.issues.update).toHaveBeenCalledTimes(1);
    expect(github.rest.issues.create).not.toHaveBeenCalled();
  });

  test('buildIssueTitle targets the tracked base branch', () => {
    expect(buildIssueTitle({ queueHealth: { target_base: 'dev' } })).toBe('CI health regression on dev');
  });
});
