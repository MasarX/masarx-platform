const {
  ISSUE_MARKER,
  buildPolicy,
  buildIssueTitle,
  buildIssueBody,
  detectFailedFamiliesFromJobs,
  evaluateRegressionThresholds,
  upsertNightlyRegressionIssue,
} = require('../../../scripts/ops/ci/nightly-regression-issue');

describe('nightly-regression-issue', () => {
  test('buildPolicy uses enabled label defaults', () => {
    const policy = buildPolicy({
      NIGHTLY_REGRESSION_ISSUE_ENABLED: '1',
      NIGHTLY_REGRESSION_ISSUE_LABEL: 'ops:nightly-regression',
    });

    expect(policy.enabled).toBe(true);
    expect(policy.label).toBe('ops:nightly-regression');
    expect(policy.workflowId).toBe('nightly-dev-heavy.yml');
    expect(policy.marker).toBe(ISSUE_MARKER);
  });

  test('detectFailedFamiliesFromJobs maps reusable workflow job names back to suite families', () => {
    const families = detectFailedFamiliesFromJobs([
      { name: 'Nightly Dev Heavy / Core / run', conclusion: 'failure' },
      { name: 'Nightly Dev Heavy / UI / run', conclusion: 'success' },
      { name: 'Nightly Dev Heavy / Mobile / run', conclusion: 'cancelled' },
    ]);

    expect(families).toEqual(['core', 'mobile']);
  });

  test('evaluateRegressionThresholds opens after a repeated family failure and closes after two greens', () => {
    expect(evaluateRegressionThresholds({
      currentFamilies: ['ui'],
      history: [
        { status: 'failed', failedFamilies: ['ui'] },
        { status: 'passed', failedFamilies: [] },
      ],
    })).toEqual(expect.objectContaining({
      openIssue: true,
      openReason: 'consecutive_ui_failure',
      closeIssue: false,
    }));

    expect(evaluateRegressionThresholds({
      currentFamilies: [],
      history: [
        { status: 'passed', failedFamilies: [] },
        { status: 'failed', failedFamilies: ['core'] },
      ],
    })).toEqual(expect.objectContaining({
      openIssue: false,
      closeIssue: true,
      closeReason: 'two_consecutive_green_runs',
    }));
  });

  test('buildIssueBody renders failures and recent history', () => {
    const body = buildIssueBody({
      summary: {
        repo: 'MasarX/MasarX',
        ref: 'dev',
        generated_at: '2026-03-29T01:30:00Z',
        status: 'failed',
        run_id: '9001',
        run_url: 'https://github.com/MasarX/MasarX/actions/runs/9001',
        failures: [{ job_id: 'ui', failure_class: 'ui_assertion_failed' }],
      },
      history: [{ generatedAt: '2026-03-28T01:30:00Z', status: 'failed', failedFamilies: ['ui'], runUrl: 'https://example.com/run/1' }],
      openReason: 'consecutive_ui_failure',
    });

    expect(body).toContain(ISSUE_MARKER);
    expect(body).toContain('Nightly Dev Heavy Regression');
    expect(body).toContain('consecutive_ui_failure');
    expect(body).toContain('ui_assertion_failed');
    expect(body).toContain('2026-03-28T01:30:00Z');
  });

  test('upsertNightlyRegressionIssue waits for the second signal before creating', async () => {
    const github = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockResolvedValue({ data: { number: 10 } }),
        },
      },
    };

    const result = await upsertNightlyRegressionIssue({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      summary: {
        ref: 'dev',
        failures: [{ job_id: 'ui', failure_class: 'ui_assertion_failed' }],
      },
      history: [
        { status: 'passed', failedFamilies: [] },
        { status: 'passed', failedFamilies: [] },
      ],
      policy: buildPolicy({ NIGHTLY_REGRESSION_ISSUE_ENABLED: '1' }),
    });

    expect(result).toEqual({ action: 'skip', reason: 'threshold_not_met' });
    expect(github.rest.issues.create).not.toHaveBeenCalled();
  });

  test('upsertNightlyRegressionIssue creates on repeated failure and closes after recovery', async () => {
    const githubCreate = {
      paginate: jest.fn().mockResolvedValue([]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockResolvedValue({ data: { number: 44 } }),
        },
      },
    };
    const ensureLabel = jest.fn().mockResolvedValue({});

    const created = await upsertNightlyRegressionIssue({
      github: githubCreate,
      owner: 'MasarX',
      repo: 'MasarX',
      summary: {
        repo: 'MasarX/MasarX',
        ref: 'dev',
        failures: [{ job_id: 'ui', failure_class: 'ui_assertion_failed' }],
      },
      history: [
        { status: 'failed', failedFamilies: ['ui'] },
        { status: 'passed', failedFamilies: [] },
      ],
      policy: buildPolicy({ NIGHTLY_REGRESSION_ISSUE_ENABLED: '1' }),
      helpers: { ensureLabel },
    });

    expect(created).toEqual({ action: 'created', issueNumber: 44 });
    expect(ensureLabel).toHaveBeenCalledTimes(1);

    const githubClose = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 44,
          body: `${ISSUE_MARKER}\nexisting`,
          labels: [{ name: 'ops:nightly-regression' }],
        },
      ]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          update: jest.fn().mockResolvedValue({}),
          create: jest.fn().mockResolvedValue({ data: { number: 45 } }),
        },
      },
    };

    const closed = await upsertNightlyRegressionIssue({
      github: githubClose,
      owner: 'MasarX',
      repo: 'MasarX',
      summary: {
        repo: 'MasarX/MasarX',
        ref: 'dev',
        failures: [],
      },
      history: [
        { status: 'passed', failedFamilies: [] },
        { status: 'failed', failedFamilies: ['ui'] },
      ],
      policy: buildPolicy({ NIGHTLY_REGRESSION_ISSUE_ENABLED: '1' }),
      helpers: { ensureLabel },
    });

    expect(closed).toEqual({ action: 'closed', issueNumber: 44 });
    expect(githubClose.rest.issues.update).toHaveBeenCalledWith(
      expect.objectContaining({
        issue_number: 44,
        state: 'closed',
        title: buildIssueTitle({ summary: { ref: 'dev' } }),
      }),
    );
  });
});
