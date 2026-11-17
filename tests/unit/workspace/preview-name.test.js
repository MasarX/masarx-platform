const {
  computeProjectName,
  extractPreviewWorkspaceFamilyName,
  extractPrNumberFromPreviewName,
  isPreviewWorkspaceFamilyMatch,
} = require('../../../scripts/ops/workspace/preview-name');

describe('workspace/preview-name helpers', () => {
  test('computeProjectName creates deterministic wk-* preview names', () => {
    expect(computeProjectName({ repo: 'MasarX/MasarX', prNumber: '1807' })).toBe('wk-masarx-pr-1807');
  });

  test('extractPreviewWorkspaceFamilyName normalizes recovery project variants', () => {
    expect(extractPreviewWorkspaceFamilyName('wk-masarx-pr-1807')).toBe('wk-masarx-pr-1807');
    expect(extractPreviewWorkspaceFamilyName('wk-masarx-pr-1807-r-deadbee1')).toBe('wk-masarx-pr-1807');
    expect(extractPreviewWorkspaceFamilyName('wk-masarx-worktree-demo')).toBe('');
  });

  test('extractPrNumberFromPreviewName supports deterministic and recovery names', () => {
    expect(extractPrNumberFromPreviewName('wk-masarx-pr-1807')).toBe('1807');
    expect(extractPrNumberFromPreviewName('wk-masarx-pr-1807-r-deadbee1')).toBe('1807');
  });

  test('isPreviewWorkspaceFamilyMatch matches exact and recovery names within one PR family', () => {
    expect(isPreviewWorkspaceFamilyMatch({
      name: 'wk-masarx-pr-1807',
      familyName: 'wk-masarx-pr-1807',
    })).toBe(true);
    expect(isPreviewWorkspaceFamilyMatch({
      name: 'wk-masarx-pr-1807-r-deadbee1',
      familyName: 'wk-masarx-pr-1807',
    })).toBe(true);
    expect(isPreviewWorkspaceFamilyMatch({
      name: 'wk-masarx-pr-1808-r-deadbee1',
      familyName: 'wk-masarx-pr-1807',
    })).toBe(false);
  });
});
