const fs = require('fs');
const path = require('path');
const {
  QUEUE_SCHEMA_DIAGNOSTIC,
  QUEUE_SCHEMA_EXPECTED_OUTPUT,
  explicitAbsolutePath,
  queueConcurrencyBlocks,
  runActionlint,
  workflowFiles,
} = require('../../../scripts/ops/ci/actionlint-current-schema');

const actionlintPath = path.resolve('C:/verified-tools/actionlint.exe');
const shellcheckPath = path.resolve('C:/verified-tools/shellcheck.exe');
const contract = {
  actionlint: { version: 'v1.7.13-0.20260419144658-011a6d15e749' },
  shellcheck: { version: '0.11.0' },
  timeouts: { probe_ms: 90000, lint_ms: 90000 },
};

function verified() {
  return {
    actionlintPath,
    shellcheckPath,
    config: contract,
    versionsProbed: true,
  };
}

describe('actionlint current GitHub queue schema adapter', () => {
  test('accepts only queue:max with a non-cancelling named concurrency group', () => {
    expect(queueConcurrencyBlocks(`name: test
on: workflow_dispatch
concurrency:
  group: planning-os-mutation-v1
  cancel-in-progress: false
  queue: max
jobs: {}
`)).toEqual([{ line: 3, group: 'planning-os-mutation-v1' }]);
    expect(() => queueConcurrencyBlocks(`concurrency:
  group: test
  cancel-in-progress: true
  queue: max
`)).toThrow('requires cancel-in-progress:false');
    expect(() => queueConcurrencyBlocks(`concurrency:
  group: test
  cancel-in-progress: false
  queue: single
`)).toThrow("must be exactly 'max'");
    expect(() => queueConcurrencyBlocks(`concurrency:
  cancel-in-progress: false
  queue: max
`)).toThrow('requires a non-empty group');
  });

  test('discovers the exact sorted nonempty top-level workflow set', () => {
    const files = workflowFiles(path.resolve(__dirname, '../../..'));
    expect(files.length).toBeGreaterThan(0);
    expect(files).toEqual([...files].sort());
    expect(files.every((file) => path.dirname(file).endsWith(path.join('.github', 'workflows')))).toBe(true);
    expect(files.every((file) => /\.ya?ml$/i.test(file))).toBe(true);
    const emptyRoot = fs.mkdtempSync(path.join(require('os').tmpdir(), 'masarx-empty-workflows-'));
    fs.mkdirSync(path.join(emptyRoot, '.github', 'workflows'), { recursive: true });
    expect(() => workflowFiles(emptyRoot)).toThrow('No top-level workflow YAML files');
    fs.rmSync(emptyRoot, { recursive: true, force: true });
  });

  test('suppresses only the known stale-schema diagnostic after independent validation', () => {
    const file = path.join(__dirname, 'actionlint-queue-fixture.yml');
    const originalReadFileSync = fs.readFileSync;
    const read = jest.spyOn(fs, 'readFileSync').mockImplementation((target, ...rest) => {
      if (target === file) return `concurrency:\n  group: test\n  cancel-in-progress: false\n  queue: max\n`;
      return originalReadFileSync(target, ...rest);
    });
    const spawn = jest.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: QUEUE_SCHEMA_EXPECTED_OUTPUT })
      .mockReturnValueOnce({ status: 0, stdout: '', stderr: '' });

    expect(runActionlint({
      files: [file],
      executable: actionlintPath,
      shellcheckExecutable: shellcheckPath,
      spawn,
      verifyToolchain: verified,
    })).toEqual({ workflowCount: 1, queueBlockCount: 1 });
    expect(spawn.mock.calls).toEqual([
      [actionlintPath, [`-shellcheck=${shellcheckPath}`, '-'], expect.objectContaining({ timeout: 90000 })],
      [actionlintPath, [
        `-shellcheck=${shellcheckPath}`, '-ignore', QUEUE_SCHEMA_DIAGNOSTIC, file,
      ], expect.objectContaining({ timeout: 90000 })],
    ]);
    read.mockRestore();
  });

  test('fails closed on native queue support, missing diagnostics, or mixed diagnostics', () => {
    const execute = (results) => runActionlint({
      files: [],
      executable: actionlintPath,
      shellcheckExecutable: shellcheckPath,
      spawn: jest.fn().mockImplementation(() => results.shift()),
      verifyToolchain: verified,
    });
    expect(() => execute([{ status: 0, stdout: '', stderr: '' }])).toThrow('remove the queue schema adapter');
    expect(() => execute([{ status: 1, stdout: '', stderr: 'different failure' }])).toThrow('unexpected reason');
    expect(() => execute([{
      status: 1,
      stdout: '',
      stderr: `${QUEUE_SCHEMA_EXPECTED_OUTPUT}\nunrelated parse failure`,
    }])).toThrow('unexpected reason');
  });

  test('requires exact verified absolute exports with no ambient fallback', () => {
    expect(() => explicitAbsolutePath('ACTIONLINT_BIN', '')).toThrow('must be explicitly exported');
    expect(() => explicitAbsolutePath('ACTIONLINT_BIN', 'actionlint')).toThrow('must be an absolute path');
    expect(() => explicitAbsolutePath('SHELLCHECK_BIN', '')).toThrow('must be explicitly exported');
    expect(() => runActionlint({
      files: [],
      executable: actionlintPath,
      shellcheckExecutable: shellcheckPath,
      verifyToolchain: () => ({ ...verified(), versionsProbed: false }),
    })).toThrow('did not prove exact versions');
  });

  test('fails closed when a probe or lint exceeds the configured bound', () => {
    const timedOut = Object.assign(new Error('spawn timed out'), { code: 'ETIMEDOUT' });
    expect(() => runActionlint({
      files: [],
      executable: actionlintPath,
      shellcheckExecutable: shellcheckPath,
      spawn: jest.fn().mockReturnValue({ status: null, stdout: '', stderr: '', error: timedOut }),
      verifyToolchain: verified,
    })).toThrow('actionlint queue-schema probe timed out after 90000ms');

    const lintSpawn = jest.fn()
      .mockReturnValueOnce({ status: 1, stdout: '', stderr: QUEUE_SCHEMA_EXPECTED_OUTPUT })
      .mockReturnValueOnce({ status: null, stdout: '', stderr: '', error: timedOut });
    expect(() => runActionlint({
      files: [],
      executable: actionlintPath,
      shellcheckExecutable: shellcheckPath,
      spawn: lintSpawn,
      verifyToolchain: verified,
    })).toThrow('actionlint workflow lint timed out after 90000ms');
  });

});
