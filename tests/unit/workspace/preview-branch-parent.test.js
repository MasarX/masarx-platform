const {
  resolveBranchParentCandidates,
  isRemovedBranchParentError,
  shouldFallbackToProjectMode,
  shouldTryAlternateBranchParent,
  withBranchParentFallback,
} = require('../../../scripts/ops/workspace/preview-branch-parent');

describe('workspace/preview-branch-parent', () => {
  test('resolveBranchParentCandidates keeps deterministic priority and deduplicates', () => {
    const env = {
      PREVIEW_SUPABASE_BRANCH_PARENT_REF: 'preview-parent',
      SUPABASE_BRANCH_PARENT_REF: 'branch-parent',
      SUPABASE_PROJECT_ID: '3c883ea5-7cc5-4d35-a5ef-100221683d72',
      SUPABASE_PARENT_PROJECT_REF: 'legacy-parent',
      PREVIEW_PROJECT_REF: 'preview-project',
      PREVIEW_SUPABASE_PROJECT_ID: 'preview-project',
    };
    const refs = resolveBranchParentCandidates({
      env,
      resolvedConfig: { branchParentRef: 'cfg-parent' },
      extra: ['3c883ea5-7cc5-4d35-a5ef-100221683d72', 'extra-parent'],
    });

    expect(refs).toEqual([
      'preview-parent',
      'branch-parent',
      '3c883ea5-7cc5-4d35-a5ef-100221683d72',
      'legacy-parent',
      'preview-project',
      'cfg-parent',
      'extra-parent',
    ]);
  });

  test('shouldTryAlternateBranchParent allows fallback for 403/404 and removed parents', () => {
    expect(shouldTryAlternateBranchParent({ status: 403 })).toBe(true);
    expect(shouldTryAlternateBranchParent({ status: 404 })).toBe(true);
    expect(shouldTryAlternateBranchParent({ status: 400, message: 'Resource has been removed' })).toBe(true);
    expect(shouldTryAlternateBranchParent({ status: 400 })).toBe(false);
    expect(shouldTryAlternateBranchParent({ status: 500 })).toBe(false);
  });

  test('shouldFallbackToProjectMode allows auto fallback for unsupported branching responses', () => {
    expect(shouldFallbackToProjectMode({ status: 401, message: 'JWT could not be decoded' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 403 })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 404 })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 422 })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 401, message: 'invalid JWT' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 429, message: 'rate limit exceeded' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 500, message: 'server error' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 0, message: 'fetch failed ECONNRESET' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 409, message: 'Failed to insert preview branch' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 400, message: 'Not authorized to enable preview branching' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 400, message: 'Resource has been removed' })).toBe(true);
    expect(shouldFallbackToProjectMode({ status: 401, message: 'unauthorized' })).toBe(false);
    expect(shouldFallbackToProjectMode({ status: 400, message: 'validation failed' })).toBe(false);
  });

  test('isRemovedBranchParentError matches removed branch parent responses', () => {
    expect(isRemovedBranchParentError({ status: 400, message: 'Resource has been removed' })).toBe(true);
    expect(isRemovedBranchParentError({ status: 400, body: { message: 'Resource has been removed' } })).toBe(true);
    expect(isRemovedBranchParentError({ status: 404, message: 'Resource has been removed' })).toBe(false);
  });

  test('withBranchParentFallback retries next parent on 403', async () => {
    const warn = jest.fn();
    const action = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('not authorized'), { status: 403 }))
      .mockResolvedValueOnce({ project_ref: 'proj-123' });

    const result = await withBranchParentFallback({
      parentRefs: ['parent-a', 'parent-b'],
      actionLabel: 'ensure branch',
      action,
      warn,
    });

    expect(result).toEqual({
      parentProjectRef: 'parent-b',
      value: { project_ref: 'proj-123' },
    });
    expect(action).toHaveBeenCalledTimes(2);
    expect(action).toHaveBeenNthCalledWith(1, 'parent-a', 0);
    expect(action).toHaveBeenNthCalledWith(2, 'parent-b', 1);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('withBranchParentFallback retries next parent when the provider says the branch parent was removed', async () => {
    const warn = jest.fn();
    const action = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('Resource has been removed'), { status: 400 }))
      .mockResolvedValueOnce({ project_ref: 'proj-456' });

    const result = await withBranchParentFallback({
      parentRefs: ['parent-a', 'parent-b'],
      actionLabel: 'ensure branch',
      action,
      warn,
    });

    expect(result).toEqual({
      parentProjectRef: 'parent-b',
      value: { project_ref: 'proj-456' },
    });
    expect(action).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test('withBranchParentFallback fails fast on non-fallback errors', async () => {
    const action = jest
      .fn()
      .mockRejectedValueOnce(Object.assign(new Error('validation failed'), { status: 400 }));

    await expect(withBranchParentFallback({
      parentRefs: ['parent-a', 'parent-b'],
      actionLabel: 'ensure branch',
      action,
      warn: jest.fn(),
    })).rejects.toThrow('validation failed');
    expect(action).toHaveBeenCalledTimes(1);
  });
});
