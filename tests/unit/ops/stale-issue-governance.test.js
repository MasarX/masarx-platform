const {
  MODE_MARK_ONLY,
  MODE_CLOSE_ONLY,
  MODE_MARK_AND_CLOSE,
  buildPolicy,
  classifyIssue,
  renderComment,
  runStaleIssueGovernance,
} = require('../../../scripts/ops/ci/stale-issue-governance');

describe('stale-issue-governance', () => {
  test('buildPolicy merges defaults with overrides', () => {
    const policy = buildPolicy(
      {
        enabled: true,
        stale_after_days: 30,
        close_after_days: 14,
        max_issues_per_run: 200,
        max_actions_per_run: 50,
        skip_if_open_pr_reference: true,
        skip_if_assigned: false,
        stale_label: { name: 'status:stale', color: 'aaaaaa', description: 'stale' },
        exempt_labels: ['kind:worker-plan'],
        never_close_labels: ['priority:p0'],
      },
      {
        ISSUE_STALE_AFTER_DAYS: '45',
        ISSUE_STALE_EXEMPT_LABELS_CSV: 'ops,supabase',
      },
      {
        dry_run: 'true',
        mode: MODE_MARK_ONLY,
        issue_number: '1086',
      },
    );

    expect(policy.enabled).toBe(true);
    expect(policy.dryRun).toBe(true);
    expect(policy.mode).toBe(MODE_MARK_ONLY);
    expect(policy.staleAfterDays).toBe(45);
    expect(policy.closeAfterDays).toBe(14);
    expect(policy.onlyIssueNumber).toBe(1086);
    expect(policy.exemptLabels.has('kind:worker-plan')).toBe(true);
    expect(policy.exemptLabels.has('ops')).toBe(true);
    expect(policy.neverCloseLabels.has('priority:p0')).toBe(true);
  });

  test('classifyIssue marks stale when inactive threshold is reached', () => {
    const now = new Date('2026-02-18T00:00:00Z');
    const policy = buildPolicy({ stale_after_days: 30, close_after_days: 14 }, {}, { mode: MODE_MARK_AND_CLOSE });
    const out = classifyIssue(
      {
        number: 200,
        updated_at: '2025-12-01T00:00:00Z',
        labels: [],
        assignees: [],
      },
      policy,
      now,
    );

    expect(out.action).toBe('mark_stale');
    expect(out.reason).toBe('inactive_timeout');
  });

  test('classifyIssue skips exempt labels', () => {
    const now = new Date('2026-02-18T00:00:00Z');
    const policy = buildPolicy(
      { stale_after_days: 30, close_after_days: 14, exempt_labels: ['kind:worker-plan'] },
      {},
      { mode: MODE_MARK_AND_CLOSE },
    );
    const out = classifyIssue(
      {
        number: 201,
        updated_at: '2025-12-01T00:00:00Z',
        labels: [{ name: 'kind:worker-plan' }],
        assignees: [],
      },
      policy,
      now,
    );

    expect(out.action).toBe('skip');
    expect(out.reason).toBe('exempt_label');
  });

  test('classifyIssue closes stale labeled issues after close threshold', () => {
    const now = new Date('2026-02-18T00:00:00Z');
    const policy = buildPolicy(
      { stale_after_days: 30, close_after_days: 14, stale_label: { name: 'status:stale' } },
      {},
      { mode: MODE_CLOSE_ONLY },
    );
    const out = classifyIssue(
      {
        number: 202,
        updated_at: '2026-01-01T00:00:00Z',
        labels: [{ name: 'status:stale' }],
        assignees: [],
      },
      policy,
      now,
    );

    expect(out.action).toBe('close');
    expect(out.reason).toBe('stale_timeout');
  });

  test('runStaleIssueGovernance marks stale and comments when active', async () => {
    const ensureLabel = jest.fn().mockResolvedValue({});
    const upsertComment = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});
    const updateIssue = jest.fn().mockResolvedValue({});
    const search = jest.fn().mockResolvedValue({ data: { total_count: 0 } });

    const github = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 301,
          updated_at: '2025-12-01T00:00:00Z',
          labels: [],
          assignees: [],
        },
      ]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          addLabels,
          update: updateIssue,
        },
        search: {
          issuesAndPullRequests: search,
        },
      },
    };

    const policy = buildPolicy(
      {
        enabled: true,
        stale_after_days: 30,
        close_after_days: 14,
        stale_label: { name: 'status:stale', color: 'fff000', description: 'stale' },
      },
      {},
      { mode: MODE_MARK_AND_CLOSE, dry_run: 'false' },
    );

    const result = await runStaleIssueGovernance({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      policy,
      helpers: { ensureLabel, upsertComment },
      now: new Date('2026-02-18T00:00:00Z'),
      logger: { info: jest.fn() },
    });

    expect(result.marked).toBe(1);
    expect(result.closed).toBe(0);
    expect(ensureLabel).toHaveBeenCalledTimes(1);
    expect(addLabels).toHaveBeenCalledTimes(1);
    expect(upsertComment).toHaveBeenCalledTimes(1);
    expect(updateIssue).not.toHaveBeenCalled();
  });

  test('runStaleIssueGovernance skips issues linked to open PR references', async () => {
    const ensureLabel = jest.fn().mockResolvedValue({});
    const upsertComment = jest.fn().mockResolvedValue({});
    const addLabels = jest.fn().mockResolvedValue({});

    const github = {
      paginate: jest.fn().mockResolvedValue([
        {
          number: 302,
          updated_at: '2025-12-01T00:00:00Z',
          labels: [],
          assignees: [],
        },
      ]),
      rest: {
        issues: {
          listForRepo: jest.fn(),
          addLabels,
          update: jest.fn().mockResolvedValue({}),
        },
        search: {
          issuesAndPullRequests: jest.fn().mockResolvedValue({ data: { total_count: 1 } }),
        },
      },
    };

    const policy = buildPolicy(
      {
        enabled: true,
        stale_after_days: 30,
        close_after_days: 14,
        skip_if_open_pr_reference: true,
      },
      {},
      { mode: MODE_MARK_AND_CLOSE, dry_run: 'false' },
    );

    const result = await runStaleIssueGovernance({
      github,
      owner: 'MasarX',
      repo: 'MasarX',
      policy,
      helpers: { ensureLabel, upsertComment },
      now: new Date('2026-02-18T00:00:00Z'),
      logger: { info: jest.fn() },
    });

    expect(result.marked).toBe(0);
    expect(result.skipped).toBe(1);
    expect(addLabels).not.toHaveBeenCalled();
    expect(upsertComment).not.toHaveBeenCalled();
  });

  test('renderComment interpolates policy placeholders', () => {
    const out = renderComment('Issue #{issue_number} stale {stale_after_days}', {
      issue_number: 10,
      stale_after_days: 30,
    });
    expect(out).toBe('Issue #10 stale 30');
  });
});
