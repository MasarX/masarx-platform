describe('gh-helpers', () => {
  describe('assignment helpers', () => {
    test('getIssueLabelNames supports object and string labels', () => {
      const { getIssueLabelNames } = require('../../../.github/scripts/gh-helpers');
      const out = getIssueLabelNames({ labels: [{ name: 'kind:worker-plan' }, 'dispatch:ready'] });
      expect(out).toEqual(['kind:worker-plan', 'dispatch:ready']);
    });

    test('resolvePriorityLabelFromNames picks highest priority label', () => {
      const { resolvePriorityLabelFromNames } = require('../../../.github/scripts/gh-helpers');
      const out = resolvePriorityLabelFromNames(['priority:p2', 'priority:p0', 'dispatch:ready']);
      expect(out).toBe('priority:p0');
    });

    test('setAssignmentLabels updates managed labels while preserving others', async () => {
      const { setAssignmentLabels } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          issues: {
            get: jest.fn().mockResolvedValue({
              data: {
                state: 'open',
                labels: [{ name: 'triage' }, { name: 'priority:p3' }, { name: 'dispatch:ready' }],
              },
            }),
            setLabels: jest.fn().mockResolvedValue({}),
          },
        },
      };

      const labels = await setAssignmentLabels({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        issueNumber: 99,
        dispatchLabel: 'dispatch:in_progress',
        priorityLabel: 'priority:p1',
        ensureKind: true,
      });

      expect(labels).toEqual(
        expect.arrayContaining(['triage', 'kind:worker-plan', 'priority:p1', 'dispatch:in_progress'])
      );
      expect(github.rest.issues.setLabels).toHaveBeenCalledTimes(1);
    });

    test('setAssignmentLabels fails closed when non-terminal dispatch is requested on a closed issue', async () => {
      const { setAssignmentLabels } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          issues: {
            get: jest.fn().mockResolvedValue({
              data: {
                state: 'closed',
                labels: [{ name: 'kind:worker-plan' }, { name: 'dispatch:done' }, { name: 'priority:p2' }],
              },
            }),
            setLabels: jest.fn().mockResolvedValue({}),
          },
        },
      };

      await expect(
        setAssignmentLabels({
          github,
          owner: 'MasarX',
          repo: 'MasarX',
          issueNumber: 100,
          dispatchLabel: 'dispatch:in_progress',
          priorityLabel: 'priority:p1',
          ensureKind: true,
        }),
      ).rejects.toThrow(
        "setAssignmentLabels: refusing to set non-terminal dispatch 'dispatch:in_progress' on closed issue #100",
      );
      expect(github.rest.issues.setLabels).not.toHaveBeenCalled();
    });

    test('normalizeAssignmentToDone sets dispatch:done, clears assignees, and closes open issue', async () => {
      const { normalizeAssignmentToDone } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          issues: {
            get: jest.fn().mockResolvedValue({
              data: {
                state: 'open',
                assignees: [{ login: 'worker-a' }],
                labels: [{ name: 'triage' }, { name: 'dispatch:in_progress' }, { name: 'priority:p2' }],
              },
            }),
            setLabels: jest.fn().mockResolvedValue({}),
            removeAssignees: jest.fn().mockResolvedValue({}),
            update: jest.fn().mockResolvedValue({}),
          },
        },
      };

      const out = await normalizeAssignmentToDone({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        issueNumber: 1126,
        priorityLabel: 'priority:p1',
        ensureKind: true,
        closeIfOpen: true,
      });

      expect(github.rest.issues.setLabels).toHaveBeenCalledTimes(1);
      expect(github.rest.issues.removeAssignees).toHaveBeenCalledWith({
        owner: 'MasarX',
        repo: 'MasarX',
        issue_number: 1126,
        assignees: ['worker-a'],
      });
      expect(github.rest.issues.update).toHaveBeenCalledWith({
        owner: 'MasarX',
        repo: 'MasarX',
        issue_number: 1126,
        state: 'closed',
      });
      expect(out.closed).toBe(true);
      expect(out.assigneesCleared).toBe(1);
      expect(out.warnings).toEqual([]);
    });

    test('normalizeAssignmentToDone surfaces non-fatal warning when assignee clear/close fails', async () => {
      const { normalizeAssignmentToDone } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          issues: {
            get: jest.fn().mockResolvedValue({
              data: {
                state: 'open',
                assignees: [{ login: 'worker-b' }],
                labels: [{ name: 'dispatch:review' }, { name: 'priority:p2' }],
              },
            }),
            setLabels: jest.fn().mockResolvedValue({}),
            removeAssignees: jest.fn().mockRejectedValue(new Error('remove-failed')),
            update: jest.fn().mockRejectedValue(new Error('close-failed')),
          },
        },
      };

      const out = await normalizeAssignmentToDone({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        issueNumber: 77,
        closeIfOpen: true,
      });

      expect(out.closed).toBe(false);
      expect(out.assigneesCleared).toBe(1);
      expect(out.warnings).toEqual(
        expect.arrayContaining([
          expect.stringContaining('remove-failed'),
          expect.stringContaining('close-failed'),
        ]),
      );
    });

    test('findCommentByMarker returns the newest matching marker comment', async () => {
      const { findCommentByMarker } = require('../../../.github/scripts/gh-helpers');
      const github = {
        paginate: jest.fn().mockResolvedValue([
          {
            id: 10,
            updated_at: '2026-03-19T16:00:00Z',
            body: '<!-- masarx-local-gate -->\nold',
          },
          {
            id: 11,
            updated_at: '2026-03-19T16:30:00Z',
            body: '<!-- masarx-local-gate -->\nnew',
          },
        ]),
        rest: {
          issues: {
            listComments: jest.fn(),
          },
        },
      };

      const comment = await findCommentByMarker({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        issueNumber: 1773,
        marker: '<!-- masarx-local-gate -->',
      });

      expect(comment?.id).toBe(11);
      expect(comment?.body).toContain('new');
    });

    test('upsertComment skips API writes when the marker comment body is unchanged', async () => {
      const { upsertComment } = require('../../../.github/scripts/gh-helpers');
      const body = '<!-- marker -->\nunchanged';
      const github = {
        paginate: jest.fn().mockResolvedValue([
          {
            id: 11,
            updated_at: '2026-03-19T16:30:00Z',
            body,
          },
        ]),
        rest: {
          issues: {
            listComments: jest.fn(),
            updateComment: jest.fn().mockResolvedValue({}),
            createComment: jest.fn().mockResolvedValue({}),
          },
        },
      };

      await upsertComment({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        issueNumber: 1773,
        marker: '<!-- marker -->',
        body,
      });

      expect(github.rest.issues.updateComment).not.toHaveBeenCalled();
      expect(github.rest.issues.createComment).not.toHaveBeenCalled();
    });
  });

  describe('getDeploymentStateSummary', () => {
    test('returns success when latest deployment state is success', async () => {
      const { getDeploymentStateSummary } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          repos: {
            listDeployments: jest.fn().mockResolvedValue({
              data: [{ id: 101 }],
            }),
            listDeploymentStatuses: jest.fn().mockResolvedValue({
              data: [{ state: 'success' }],
            }),
          },
        },
      };

      const out = await getDeploymentStateSummary({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        environment: 'production',
        sha: '0123456789abcdef0123456789abcdef01234567',
      });

      expect(out).toEqual({
        deploymentCount: 1,
        latestStates: ['success'],
        hasSuccess: true,
        hasActive: false,
      });
    });

    test('treats pending deployment as active and not successful', async () => {
      const { getDeploymentStateSummary } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          repos: {
            listDeployments: jest.fn().mockResolvedValue({
              data: [{ id: 201 }],
            }),
            listDeploymentStatuses: jest.fn().mockResolvedValue({
              data: [{ state: 'pending' }],
            }),
          },
        },
      };

      const out = await getDeploymentStateSummary({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        environment: 'production',
        sha: '89abcdef0123456789abcdef0123456789abcdef',
      });

      expect(out.hasActive).toBe(true);
      expect(out.hasSuccess).toBe(false);
      expect(out.latestStates).toEqual(['pending']);
    });

    test('treats deployment with no statuses as active', async () => {
      const { getDeploymentStateSummary } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          repos: {
            listDeployments: jest.fn().mockResolvedValue({
              data: [{ id: 301 }],
            }),
            listDeploymentStatuses: jest.fn().mockResolvedValue({
              data: [],
            }),
          },
        },
      };

      const out = await getDeploymentStateSummary({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        environment: 'production',
        sha: 'fedcba9876543210fedcba9876543210fedcba98',
      });

      expect(out.hasActive).toBe(true);
      expect(out.latestStates).toEqual(['created']);
      expect(out.hasSuccess).toBe(false);
    });
  });

  describe('getWorkflowRunStateSummary', () => {
    test('returns active runs for same workflow and sha', async () => {
      const { getWorkflowRunStateSummary } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          actions: {
            listWorkflowRuns: jest.fn().mockResolvedValue({
              data: {
                workflow_runs: [
                  { id: 11, head_sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', status: 'queued', conclusion: null },
                  { id: 12, head_sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', status: 'in_progress', conclusion: null },
                ],
              },
            }),
          },
        },
      };

      const out = await getWorkflowRunStateSummary({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        workflowId: 'deploy-prod.yml',
        sha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      });

      expect(out).toEqual({
        runCount: 1,
        hasActive: true,
        hasSuccess: false,
        activeRunIds: ['11'],
        successRunIds: [],
      });
    });

    test('treats completed successful run as success and excludes current run', async () => {
      const { getWorkflowRunStateSummary } = require('../../../.github/scripts/gh-helpers');
      const github = {
        rest: {
          actions: {
            listWorkflowRuns: jest.fn().mockResolvedValue({
              data: {
                workflow_runs: [
                  { id: 91, head_sha: 'cccccccccccccccccccccccccccccccccccccccc', status: 'completed', conclusion: 'success' },
                  { id: 92, head_sha: 'cccccccccccccccccccccccccccccccccccccccc', status: 'queued', conclusion: null },
                ],
              },
            }),
          },
        },
      };

      const out = await getWorkflowRunStateSummary({
        github,
        owner: 'MasarX',
        repo: 'MasarX',
        workflowId: 'deploy-prod.yml',
        sha: 'cccccccccccccccccccccccccccccccccccccccc',
        excludeRunId: '92',
      });

      expect(out).toEqual({
        runCount: 1,
        hasActive: false,
        hasSuccess: true,
        activeRunIds: [],
        successRunIds: ['91'],
      });
    });
  });

  describe('enableAutoMerge', () => {
    test('uses mergeMethod variable (not method) to avoid Octokit reserved keys', async () => {
      const { enableAutoMerge } = require('../../../.github/scripts/gh-helpers');
      const github = { graphql: jest.fn().mockResolvedValue({}) };

      const out = await enableAutoMerge({ github, pullRequestId: 'PR_ID', mergeMethod: 'MERGE' });
      expect(out).toEqual({ ok: true, message: 'enabled' });

      expect(github.graphql).toHaveBeenCalledTimes(1);
      const [query, vars] = github.graphql.mock.calls[0];
      expect(String(query)).toContain('$mergeMethod');
      expect(String(query)).not.toContain('$method');
      expect(vars).toEqual({ prId: 'PR_ID', mergeMethod: 'MERGE' });
      expect(Object.prototype.hasOwnProperty.call(vars, 'method')).toBe(false);
    });

    test('returns ok=false when graphql throws', async () => {
      const { enableAutoMerge } = require('../../../.github/scripts/gh-helpers');
      const github = { graphql: jest.fn().mockRejectedValue(new Error('boom')) };

      const out = await enableAutoMerge({ github, pullRequestId: 'PR_ID' });
      expect(out.ok).toBe(false);
      expect(out.message).toContain('boom');
    });
  });

  describe('merge queue helpers', () => {
    test('dequeuePullRequest removes a PR from the merge queue through GraphQL', async () => {
      const { dequeuePullRequest } = require('../../../.github/scripts/gh-helpers');
      const github = {
        graphql: jest.fn().mockResolvedValue({
          dequeuePullRequest: {
            mergeQueueEntry: {
              id: 'MQE_123',
              state: 'AWAITING_CHECKS',
            },
          },
        }),
      };

      const out = await dequeuePullRequest({ github, pullRequestId: 'PR_ID' });

      expect(out).toEqual({
        ok: true,
        message: 'dequeued',
        mergeQueueEntry: {
          id: 'MQE_123',
          state: 'AWAITING_CHECKS',
        },
      });
      expect(github.graphql).toHaveBeenCalledTimes(1);
      const [query, vars] = github.graphql.mock.calls[0];
      expect(String(query)).toContain('dequeuePullRequest');
      expect(vars).toEqual({ id: 'PR_ID' });
    });
  });
});
