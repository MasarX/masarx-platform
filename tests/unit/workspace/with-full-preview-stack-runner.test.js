jest.mock('child_process', () => ({
  spawnSync: jest.fn(() => ({
    stdout: 'preview ok\n',
    stderr: '',
    status: 0,
  })),
}));

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  runPreviewStackCommand,
} = require('../../../scripts/ops/workspace/with-full-preview-stack');

describe('with-full-preview-stack runner buffer handling', () => {
  afterEach(() => {
    spawnSync.mockClear();
  });

  test('uses the current default maxBuffer for preview child processes', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-stack-run-'));
    try {
      const result = runPreviewStackCommand('node', ['-e', 'process.stdout.write("preview ok")'], {
        cwd: tempDir,
        env: {},
        label: 'preview prewarm',
      });

      expect(result.outputLineCount).toBeGreaterThan(0);
      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync.mock.calls[0][2]).toEqual(
        expect.objectContaining({
          maxBuffer: 128 * 1024 * 1024,
          stdio: ['ignore', 'pipe', 'pipe'],
          encoding: 'utf8',
        })
      );
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('honors explicit maxBuffer overrides before env defaults', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'preview-stack-run-'));
    try {
      runPreviewStackCommand('node', ['-e', 'process.stdout.write("preview ok")'], {
        cwd: tempDir,
        env: { PREVIEW_STACK_MAX_BUFFER_BYTES: '8192' },
        maxBufferBytes: 1234,
        label: 'preview deploy',
      });

      expect(spawnSync).toHaveBeenCalledTimes(1);
      expect(spawnSync.mock.calls[0][2].maxBuffer).toBe(1234);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
