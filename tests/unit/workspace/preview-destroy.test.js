const {
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
});
