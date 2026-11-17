const { buildEnvironmentUpsertBody } = require('../../../scripts/utils/gh-cli');

describe('gh-cli buildEnvironmentUpsertBody', () => {
  test('defaults to protected branches only', () => {
    expect(buildEnvironmentUpsertBody()).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });
  });

  test('allowedBranches enables custom branch policies', () => {
    expect(buildEnvironmentUpsertBody({ allowedBranches: ['dev'] })).toEqual({
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true },
    });
  });

  test('supports explicit reviewer synchronization (including clear)', () => {
    expect(buildEnvironmentUpsertBody()).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
    });

    expect(buildEnvironmentUpsertBody({ reviewers: [] })).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      reviewers: [],
    });

    expect(buildEnvironmentUpsertBody({ reviewers: [{ type: 'User', id: 123 }] })).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      reviewers: [{ type: 'User', id: 123 }],
    });
  });

  test('supports admin-bypass hardening flags', () => {
    expect(
      buildEnvironmentUpsertBody({
        reviewers: [{ type: 'User', id: 123 }],
        canAdminsBypass: false,
        preventSelfReview: false,
      }),
    ).toEqual({
      deployment_branch_policy: { protected_branches: true, custom_branch_policies: false },
      reviewers: [{ type: 'User', id: 123 }],
      can_admins_bypass: false,
      prevent_self_review: false,
    });
  });
});
