jest.mock('child_process', () => {
  const orig = jest.requireActual('child_process');
  return {
    ...orig,
    spawnSync: jest.fn(),
  };
});

const { spawnSync } = require('child_process');

const { resolveWorkspaceName } = require('../../../scripts/ops/workspace/resolve-name');

describe('resolveWorkspaceName', () => {
  beforeEach(() => {
    spawnSync.mockReset();
  });

  test('returns explicit --name without hitting git', () => {
    const name = resolveWorkspaceName({ argv: ['--name', 'my project'], cwd: 'C:\\tmp' });
    expect(name).toBe('my project');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('falls back to git worktree basename when --name is absent', () => {
    const workspaceRoot = '/example/workspace Branch';
    spawnSync.mockReturnValue({ status: 0, stdout: `${workspaceRoot}\n` });
    const name = resolveWorkspaceName({ argv: [], cwd: workspaceRoot });
    expect(name).toBe(require('path').basename(workspaceRoot));
    expect(spawnSync).toHaveBeenCalledWith(
      'git',
      ['rev-parse', '--show-toplevel'],
      expect.objectContaining({ cwd: workspaceRoot, encoding: 'utf8' })
    );
  });

  test('accepts positional name when npm strips --name', () => {
    const name = resolveWorkspaceName({ argv: ['wk-e2e-123'], cwd: 'C:\\tmp' });
    expect(name).toBe('wk-e2e-123');
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('throws when --name is provided but empty', () => {
    expect(() => resolveWorkspaceName({ argv: ['--name', '   '], cwd: 'C:\\tmp' })).toThrow(
      /--name/i
    );
    expect(spawnSync).not.toHaveBeenCalled();
  });

  test('throws when git worktree cannot be resolved', () => {
    spawnSync.mockReturnValue({ status: 1, stdout: '' });
    expect(() => resolveWorkspaceName({ argv: [], cwd: 'C:\\tmp' })).toThrow(/worktree/i);
  });

  test('fails closed instead of hanging when git worktree discovery times out', () => {
    spawnSync.mockReturnValue({
      status: null,
      stdout: 'C:\\partial',
      stderr: '',
      error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
    });

    expect(() => resolveWorkspaceName({ argv: [], cwd: 'C:\\tmp' })).toThrow(
      /git worktree probe timed out/i,
    );
  });
});
