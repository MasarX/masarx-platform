describe('gh-cli ensureGhAuth', () => {
  function loadModule() {
    jest.resetModules();
    jest.doMock('child_process', () => ({
      spawnSync: jest.fn(),
    }));
    const childProcess = require('child_process');
    const moduleUnderTest = require('../../../scripts/utils/gh-cli');
    return {
      ensureGhAuth: moduleUnderTest.ensureGhAuth,
      spawnSync: childProcess.spawnSync,
    };
  }

  test('accepts clean gh auth status', () => {
    const { ensureGhAuth, spawnSync } = loadModule();
    spawnSync.mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    expect(() => ensureGhAuth()).not.toThrow();
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(spawnSync).toHaveBeenCalledWith('gh', ['auth', 'status'], expect.objectContaining({ encoding: 'utf8' }));
  });

  test('falls back to authenticated API probe when keyring auth status is stale', () => {
    const { ensureGhAuth, spawnSync } = loadModule();
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'keyring invalid' })
      .mockReturnValueOnce({ status: 0, stdout: 'example-maintainer\n', stderr: '' });

    expect(() => ensureGhAuth()).not.toThrow();
    expect(spawnSync).toHaveBeenNthCalledWith(
      1,
      'gh',
      ['auth', 'status'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
    expect(spawnSync).toHaveBeenNthCalledWith(
      2,
      'gh',
      ['api', 'user', '--jq', '.login'],
      expect.objectContaining({ encoding: 'utf8' }),
    );
  });

  test('fails closed when auth status and API probe both fail', () => {
    const { ensureGhAuth, spawnSync } = loadModule();
    spawnSync
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'keyring invalid' })
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: 'no auth' });

    expect(() => ensureGhAuth()).toThrow(
      'gh auth status failed. Login with `gh auth login` (or set GH_TOKEN/GITHUB_TOKEN).',
    );
  });
});
