const {
  parseArgs,
  parsePreviewJson,
  shouldCleanupEnvFile,
  withPreviewEnvRun,
} = require('../../../scripts/ops/workspace/with-preview-env');
const path = require('path');

describe('with-preview-env parsing helpers', () => {
  test('parseArgs supports --pr plus command separator', () => {
    const parsed = parseArgs(['--pr', '123', '--', 'npm', 'run', 'verify:cloud']);
    expect(parsed).toEqual({
      keep: false,
      pr: '123',
      name: '',
      envFile: '',
      command: ['npm', 'run', 'verify:cloud'],
      help: undefined,
    });
  });

  test('parseArgs supports implicit command start without separator', () => {
    const parsed = parseArgs(['--pr', '123', 'npm', 'run', 'verify:cloud']);
    expect(parsed).toEqual({
      keep: false,
      pr: '123',
      name: '',
      envFile: '',
      command: ['npm', 'run', 'verify:cloud'],
      help: undefined,
    });
  });

  test('parseArgs accepts explicit env file and keep flag', () => {
    const parsed = parseArgs([
      '--name',
      'wk-demo-pr-5',
      '--env-file',
      'tmp/test.env',
      '--keep',
      '--',
      'bash',
      '-lc',
      'echo hi',
    ]);
    expect(parsed.keep).toBe(true);
    expect(parsed.name).toBe('wk-demo-pr-5');
    expect(parsed.envFile).toBe('tmp/test.env');
    expect(parsed.command).toEqual(['bash', '-lc', 'echo hi']);
  });

  test('parseArgs rejects unknown flags', () => {
    expect(() => parseArgs(['--unknown', 'x'])).toThrow('Unknown option: --unknown');
  });
});

describe('with-preview-env cleanup guard', () => {
  test('keeps pre-existing explicit env file', () => {
    expect(
      shouldCleanupEnvFile({
        shouldKeep: false,
        explicitEnvFile: '/tmp/existing.env',
        explicitEnvPreExisted: true,
        cleanupPath: '/tmp/existing.env',
      }),
    ).toBe(false);
  });

  test('deletes explicit env file only when this run created it', () => {
    expect(
      shouldCleanupEnvFile({
        shouldKeep: false,
        explicitEnvFile: '/tmp/new.env',
        explicitEnvPreExisted: false,
        cleanupPath: '/tmp/new.env',
      }),
    ).toBe(true);
  });
});

describe('with-preview-env orchestration', () => {
  test('provisions preview and runs command with preview ENV_FILE', () => {
    const spawnCalls = [];
    const cleanup = jest.fn();
    const mockSpawn = jest.fn((cmd, args, options) => {
      spawnCalls.push({ cmd, args, options });
      if (args.includes('--format') && args.includes('json')) {
        return {
          status: 0,
          stdout: [
            'info',
            JSON.stringify({
              project_ref: 'xyz',
              project_name: 'wk-demo-pr-123',
              env_file: '/tmp/masarx-preview-xyz.env.cloud',
            }),
          ].join('\n'),
          stderr: '',
          signal: null,
        };
      }
      return {
        status: 0,
        stdout: '',
        stderr: '',
        signal: null,
      };
    });

    const result = withPreviewEnvRun({
      argv: ['--pr', '123', '--', 'npm', 'run', 'verify:cloud'],
      spawnSync: mockSpawn,
      removeFile: cleanup,
      fileExistsSync: () => false,
      keepFile: false,
      env: { NODE_ENV: 'test' },
      previewScript: '/repo/scripts/ops/workspace/preview-project.js',
      nodeCommand: '/usr/bin/node',
      now: () => 1700000000000,
    });

    expect(result.status).toBe(0);
    expect(result.payload.project_ref).toBe('xyz');
    expect(result.envFile).toMatch(/masarx-preview-[0-9a-f]+\.env\.cloud$/);
    expect(result.timestamp).toBe(1700000000000);

    expect(spawnCalls[0]).toMatchObject({
      cmd: '/usr/bin/node',
      args: [
        '/repo/scripts/ops/workspace/preview-project.js',
        '--format',
        'json',
        '--pr',
        '123',
      ],
      options: {
        cwd: process.cwd(),
        env: expect.objectContaining({
          ENV_FILE: expect.stringMatching(/masarx-preview-.+\.env\.cloud/),
          ENV_FILE_APPEND: '0',
          NODE_ENV: 'test',
        }),
      },
    });

    expect(spawnCalls[1]).toMatchObject({
      cmd: 'npm',
      args: ['run', 'verify:cloud'],
      options: expect.objectContaining({
        env: expect.objectContaining({
          ENV_FILE: '/tmp/masarx-preview-xyz.env.cloud',
          ENV_FILE_APPEND: '0',
          NODE_ENV: 'test',
        }),
      }),
    });

    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(cleanup).toHaveBeenCalledWith('/tmp/masarx-preview-xyz.env.cloud');
  });

  test('throws on command failure while still cleaning up', () => {
    const mockSpawn = jest
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          project_ref: 'abc',
          env_file: '/tmp/masarx-preview-abc.env.cloud',
        }),
        stderr: '',
        signal: null,
      })
      .mockReturnValueOnce({
        status: 1,
        stdout: '',
        stderr: 'boom',
        signal: null,
      });

    const cleanup = jest.fn();
    expect(() =>
      withPreviewEnvRun({
        argv: ['--name', 'wk-demo', '--', 'npm', 'test'],
        spawnSync: mockSpawn,
        removeFile: cleanup,
        fileExistsSync: () => false,
        keepFile: false,
        env: { NODE_ENV: 'test' },
        previewScript: '/repo/scripts/ops/workspace/preview-project.js',
        nodeCommand: '/usr/bin/node',
      })
    ).toThrow('Command failed');

    expect(cleanup).toHaveBeenCalledWith('/tmp/masarx-preview-abc.env.cloud');
  });

  test('cleans temp env file even if preview metadata cannot be parsed', () => {
    const mockSpawn = jest.fn().mockReturnValue({
      status: 0,
      stdout: ['info', '{invalid', 'json'],
      stderr: '',
      signal: null,
    });

    const cleanup = jest.fn();
    expect(() =>
      withPreviewEnvRun({
        argv: ['--env-file', '/tmp/preview.env.cloud', '--pr', '321', '--', 'npm', 'run', 'verify:cloud'],
        spawnSync: mockSpawn,
        removeFile: cleanup,
        fileExistsSync: () => false,
        keepFile: false,
        env: { NODE_ENV: 'test' },
        previewScript: '/repo/scripts/ops/workspace/preview-project.js',
        nodeCommand: '/usr/bin/node',
      })
    ).toThrow('preview-project did not return env_file metadata in JSON output.');

    expect(cleanup).toHaveBeenCalledWith(path.resolve('/tmp/preview.env.cloud'));
  });

  test('respects --keep (no cleanup)', () => {
    const mockSpawn = jest
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          project_ref: 'abc',
          env_file: '/tmp/masarx-preview-abc.env.cloud',
        }),
        stderr: '',
        signal: null,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        signal: null,
      });

    const cleanup = jest.fn();
    const result = withPreviewEnvRun({
      argv: ['--name', 'wk-demo', '--keep', '--', 'npm', 'run', 'verify:cloud'],
      spawnSync: mockSpawn,
      removeFile: cleanup,
      fileExistsSync: () => false,
      keepFile: false,
      env: { NODE_ENV: 'test' },
      previewScript: '/repo/scripts/ops/workspace/preview-project.js',
      nodeCommand: '/usr/bin/node',
    });

    expect(result.status).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(0);
  });

  test('parsePreviewJson pulls last JSON object from mixed output', () => {
    const payload = parsePreviewJson(
      [
        '[preview-project] workspace',
        'line',
        JSON.stringify({ project_ref: 'abc', env_file: '/tmp/.env.cloud' }),
      ].join('\n'),
    );
    expect(payload).toEqual({
      project_ref: 'abc',
      env_file: '/tmp/.env.cloud',
    });
  });

  test('does not delete explicit env-file when it existed before run', () => {
    const mockSpawn = jest
      .fn()
      .mockReturnValueOnce({
        status: 0,
        stdout: JSON.stringify({
          project_ref: 'abc',
          env_file: '/tmp/existing-preview.env.cloud',
        }),
        stderr: '',
        signal: null,
      })
      .mockReturnValueOnce({
        status: 0,
        stdout: '',
        stderr: '',
        signal: null,
      });

    const cleanup = jest.fn();
    const result = withPreviewEnvRun({
      argv: ['--env-file', '/tmp/existing-preview.env.cloud', '--name', 'wk-demo', '--', 'npm', 'run', 'verify:cloud'],
      spawnSync: mockSpawn,
      removeFile: cleanup,
      fileExistsSync: () => true,
      keepFile: false,
      env: { NODE_ENV: 'test' },
      previewScript: '/repo/scripts/ops/workspace/preview-project.js',
      nodeCommand: '/usr/bin/node',
    });

    expect(result.status).toBe(0);
    expect(cleanup).toHaveBeenCalledTimes(0);
  });
});
