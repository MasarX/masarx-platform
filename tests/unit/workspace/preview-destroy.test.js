const {
  assertExactBranchIdentity,
  parseArgs,
  parseEnabled,
  resolveProjectDeleteTargets,
} = require('../../../scripts/ops/workspace/preview-destroy');

describe('workspace/preview-destroy helpers', () => {
  test('parseArgs captures delete-family mode', () => {
    expect(parseArgs(['--pr', '1807', '--delete-family', '1'])).toEqual({
      pr: '1807',
      'delete-family': '1',
    });
  });

  test('parseEnabled handles common boolean forms', () => {
    expect(parseEnabled('enabled')).toBe(true);
    expect(parseEnabled('0')).toBe(false);
    expect(parseEnabled('', true)).toBe(true);
  });

  test('resolveProjectDeleteTargets expands to the full same-PR family when enabled', () => {
    const result = resolveProjectDeleteTargets({
      projects: [
        { name: 'wk-masarx-pr-1807', ref: 'ref-old', created_at: '2026-03-08T01:00:00Z' },
        { name: 'wk-masarx-pr-1807-r-deadbee1', ref: 'ref-new', created_at: '2026-03-08T02:00:00Z' },
        { name: 'wk-masarx-pr-1808', ref: 'ref-other', created_at: '2026-03-08T03:00:00Z' },
      ],
      workspaceName: 'wk-masarx-pr-1807',
      deleteFamily: true,
    });

    expect(result.familyName).toBe('wk-masarx-pr-1807');
    expect(result.matches).toEqual([
      { name: 'wk-masarx-pr-1807', ref: 'ref-old', createdAt: '2026-03-08T01:00:00Z' },
      { name: 'wk-masarx-pr-1807-r-deadbee1', ref: 'ref-new', createdAt: '2026-03-08T02:00:00Z' },
    ]);
  });

  test('resolveProjectDeleteTargets keeps exact-name deletion for non-family workspaces', () => {
    const result = resolveProjectDeleteTargets({
      projects: [
        { name: 'wk-canary-123', ref: 'ref-canary', created_at: '2026-03-08T01:00:00Z' },
        { name: 'wk-canary-456', ref: 'ref-other', created_at: '2026-03-08T02:00:00Z' },
      ],
      workspaceName: 'wk-canary-123',
      deleteFamily: true,
    });

    expect(result.familyName).toBe('');
    expect(result.matches).toEqual([
      { name: 'wk-canary-123', ref: 'ref-canary', createdAt: '2026-03-08T01:00:00Z' },
    ]);
  });

  test('resolveProjectDeleteTargets keeps exact preview deletion when family expansion is disabled', () => {
    const result = resolveProjectDeleteTargets({
      projects: [
        { name: 'wk-masarx-pr-1807', ref: 'ref-base', created_at: '2026-03-08T01:00:00Z' },
        { name: 'wk-masarx-pr-1807-r-deadbee1', ref: 'ref-recovery', created_at: '2026-03-08T02:00:00Z' },
      ],
      workspaceName: 'wk-masarx-pr-1807',
      deleteFamily: false,
    });

    expect(result.familyName).toBe('');
    expect(result.matches).toEqual([
      { name: 'wk-masarx-pr-1807', ref: 'ref-base', createdAt: '2026-03-08T01:00:00Z' },
    ]);
  });

  test('exact branch deletion rejects a replacement generation with the same name', () => {
    expect(() => assertExactBranchIdentity({
      branch: { branch_id: 'replacement-id', project_ref: 'bcdefghijklmnopqrstu' },
      expectedBranchId: 'owned-id',
      expectedProjectRef: 'abcdefghijklmnopqrst',
    })).toThrow('branch_identity_mismatch:branch_id:replacement-id:owned-id');
    expect(() => assertExactBranchIdentity({
      branch: { branch_id: 'owned-id', project_ref: 'bcdefghijklmnopqrstu' },
      expectedBranchId: 'owned-id',
      expectedProjectRef: 'abcdefghijklmnopqrst',
    })).toThrow('branch_identity_mismatch:project_ref:bcdefghijklmnopqrstu:abcdefghijklmnopqrst');
  });

  test('exact af38b526-f5c1-468d-88fb-86677fbe872a deletion does not select a replacement with the same name', () => {
    expect(resolveProjectDeleteTargets({
      projects: [
        { name: 'wk-masarx-pr-1807', ref: 'replacement-ref' },
      ],
      workspaceName: 'wk-masarx-pr-1807',
      deleteFamily: false,
      expectedProjectRef: 'deleted-generation-ref',
    })).toEqual({ familyName: '', matches: [] });
  });

  test('exact af38b526-f5c1-468d-88fb-86677fbe872a deletion fails closed when the ref has been renamed', () => {
    expect(resolveProjectDeleteTargets({
      projects: [{ name: 'wk-masarx-pr-1808', ref: 'expected-ref' }],
      workspaceName: 'wk-masarx-pr-1807',
      deleteFamily: false,
      expectedProjectRef: 'expected-ref',
    })).toEqual(expect.objectContaining({
      matches: [],
      identityMismatch: 'project_name:wk-masarx-pr-1808:wk-masarx-pr-1807',
    }));
  });

  test('project teardown passes the same resolved preview organization and token into deletion proof', async () => {
    const originalArgv = process.argv;
    const originalGithubActions = process.env.GITHUB_ACTIONS;
    const originalGithubRepository = process.env.GITHUB_REPOSITORY;
    const listProjects = jest.fn().mockResolvedValue([{
      name: 'wk-wire-test',
      ref: 'abcdefghijklmnopqrst',
      organization_id: 'exact-org-id',
    }]);
    const deleteProjectWithRetries = jest.fn().mockResolvedValue(undefined);
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});

    jest.resetModules();
    jest.doMock('../../../scripts/ops/workspace/preview-supabase-config', () => ({
      resolvePreviewSupabaseConfig: () => ({
        token: 'EXAMPLE_PASSWORD',
        orgId: 'exact-org-id',
        workspaceMode: 'project',
        missing: [],
      }),
    }));
    jest.doMock('../../../scripts/ops/workspace/supabase-api', () => ({
      deleteBranchWithRetries: jest.fn(),
      deleteProjectWithRetries,
      findBranchByName: jest.fn(),
      listProjects,
    }));

    try {
      process.argv = [
        process.execPath,
        'preview-destroy.js',
        '--name',
        'wk-wire-test',
        '--workspace-mode',
        'project',
        '--delete-family',
        '0',
      ];
      process.env.GITHUB_ACTIONS = 'true';
      process.env.GITHUB_REPOSITORY = 'MasarX/MasarX';
      const { main } = require('../../../scripts/ops/workspace/preview-destroy');

      await main();

      expect(listProjects).toHaveBeenCalledWith({
        token: 'EXAMPLE_PASSWORD',
        organizationId: 'exact-org-id',
      });
      expect(deleteProjectWithRetries).toHaveBeenCalledWith(
        'abcdefghijklmnopqrst',
        'EXAMPLE_PASSWORD',
        expect.objectContaining({ organizationId: 'exact-org-id' }),
      );
    } finally {
      process.argv = originalArgv;
      if (originalGithubActions == null) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = originalGithubActions;
      if (originalGithubRepository == null) delete process.env.GITHUB_REPOSITORY;
      else process.env.GITHUB_REPOSITORY = originalGithubRepository;
      logSpy.mockRestore();
      jest.dontMock('../../../scripts/ops/workspace/preview-supabase-config');
      jest.dontMock('../../../scripts/ops/workspace/supabase-api');
      jest.resetModules();
    }
  });
});
