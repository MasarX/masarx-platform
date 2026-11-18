const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '../../..');
const toolchain = require('../../../scripts/ops/pr-validation-pg-prove-toolchain');
const toolchainCli = require('../../../scripts/ops/pr-validation-pg-prove-toolchain-cli');

const imageId = `sha256:${'a'.repeat(64)}`;
let temporaryDirectories = [];

function validInspect(loaded, overrides = {}) {
  return JSON.stringify([{
    Id: imageId,
    Config: {
      Labels: {
        ...toolchain.expectedImageLabels(loaded),
        ...(overrides.labels || {}),
      },
    },
    ...overrides.image,
  }]);
}

function validContainerInspect(name, expected, overrides = {}) {
  return JSON.stringify([{
    Id: 'b'.repeat(64),
    Name: `/${name}`,
    Image: expected.imageId,
    Config: {
      Labels: {
        ...expected.labels,
        ...(overrides.labels || {}),
      },
    },
    ...overrides.container,
  }]);
}

function stateDirectory() {
  const root = path.join(repoRoot, '.tmp');
  fs.mkdirSync(root, { recursive: true });
  const result = fs.mkdtempSync(path.join(root, 'pg-prove-toolchain-test-'));
  temporaryDirectories.push(result);
  return result;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe('containerized pg_prove toolchain', () => {
  test('loads an exact pinned image and package contract', () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    expect(loaded.policy).toMatchObject({
      schema: 'masarx_pr_validation_pg_prove_toolchain_v1',
      engine: 'pg_prove',
      execution_mode: 'ephemeral_docker_container',
      image: {
        package: 'libtap-parser-sourcehandler-pgtap-perl',
        package_version: '3.36-2',
        pg_prove_version: '3.36',
        psql_major: 15,
      },
    });
    expect(loaded.policy.image.base).toMatch(/^postgres:15-bookworm@sha256:[a-f0-9]{64}$/u);
    expect(loaded.policySha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(loaded.dockerfileSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  test('fails closed when the prepared image labels do not match source', () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const spawnSyncImpl = jest.fn(() => ({
      status: 0,
      stdout: validInspect(loaded, {
        labels: { 'org.masarx.pg-prove.policy-sha256': 'b'.repeat(64) },
      }),
    }));
    expect(() => toolchain.inspectImage(loaded, { spawnSyncImpl }))
      .toThrow('focused_pg_prove_toolchain_label_mismatch');
  });

  test('maps only canonical wrapper files and the loopback database into the hardened container', () => {
    const state = stateDirectory();
    const phase = path.join(state, 'parallel_wave-00001');
    fs.mkdirSync(phase);
    const wrapper = path.join(phase, '001-aaaaaaaaaaaaaaaa.sql');
    fs.writeFileSync(wrapper, 'SELECT 1;\n');
    const previousPassword = process.env.PGPASSWORD;
    process.env.PGPASSWORD = 'not-recorded-in-command';
    try {
      const command = toolchain.buildDockerRunCommand({
        cwd: repoRoot,
        imageId,
        stateDirectory: state,
        phase: 'parallel_wave',
        timeoutMs: 600000,
        logicalArgs: [
          '--norc', '--jobs', '1', '--host', '127.0.0.1', '--port', '56333',
          '--username', 'postgres', '--dbname', 'postgres', wrapper,
        ],
      });
      expect(command.command).toBe('docker');
      expect(command.args).toEqual(expect.arrayContaining([
        'run', '--rm', '--init', '--pull', 'never', '--read-only', '--cap-drop', 'ALL',
        '--security-opt', 'no-new-privileges', '--env', 'PGPASSWORD',
        'pg-prove.example.test', '/state/parallel_wave-00001/001-aaaaaaaaaaaaaaaa.sql',
      ]));
      const loaded = toolchain.loadPolicy(repoRoot);
      expect(command.args).toEqual(expect.arrayContaining([
        '--label', `org.masarx.pg-prove.policy-sha256=${loaded.policySha256}`,
        '--label', `org.masarx.pg-prove.dockerfile-sha256=${loaded.dockerfileSha256}`,
      ]));
      expect(command.args.join(' ')).not.toContain(process.env.PGPASSWORD);
      expect(command.args).toContain(imageId);
      expect(command.args).not.toContain(wrapper);
      expect(command.stateFile).toBe(path.join(state, '.pg_prove'));
      expect(command.internalTimeoutMs).toBeLessThan(600000);
    } finally {
      if (previousPassword == null) delete process.env.PGPASSWORD;
      else process.env.PGPASSWORD = previousPassword;
    }
  });

  test('rejects an unmounted absolute argument before Docker starts', () => {
    const state = stateDirectory();
    expect(() => toolchain.buildDockerRunCommand({
      cwd: repoRoot,
      stateDirectory: state,
      phase: 'serial_quarantine',
      timeoutMs: 600000,
      logicalArgs: ['--host', '127.0.0.1', path.resolve(repoRoot, 'outside.sql')],
    })).toThrow('unmounted absolute host path');
  });

  test('binds the owner runner to the dedicated CLI without enabling a shell', () => {
    const state = stateDirectory();
    const wrapper = path.join(state, '001-safe.sql');
    fs.writeFileSync(wrapper, 'SELECT 1;\n');
    const command = toolchain.buildToolchainCommand({
      cwd: repoRoot,
      stateDirectory: state,
      phase: 'serial_quarantine',
      timeoutMs: 600000,
      logicalArgs: ['--host', '127.0.0.1', wrapper],
    });
    expect(command.command).toBe(process.execPath);
    expect(command.args[0]).toBe(path.join(repoRoot, 'scripts', 'ops', 'pr-validation-pg-prove-toolchain-cli.js'));
    expect(toolchainCli.parseCli(command.args.slice(1))).toMatchObject({
      command: 'run',
      cwd: repoRoot,
      stateDirectory: state,
      phase: 'serial_quarantine',
      timeoutMs: 600000,
      logicalArgs: ['--host', '127.0.0.1', wrapper],
    });
  });

  test('requires one matching start and zero-residual terminal marker', () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const start = `${toolchain.START_MARKER} image=${imageId} policy=${loaded.policySha256} dockerfile=${loaded.dockerfileSha256} container=masarx-pgtap-abc123`;
    const done = `${toolchain.DONE_MARKER} image=${imageId} policy=${loaded.policySha256} dockerfile=${loaded.dockerfileSha256} container=masarx-pgtap-abc123 residual=0 exit=1`;
    expect(toolchain.assertToolchainEvidence(`${start}\n${done}\n`, { cwd: repoRoot })).toMatchObject({
      imageId,
      containerName: 'masarx-pgtap-abc123',
      residual: 0,
      exit: 1,
    });
    expect(() => toolchain.assertToolchainEvidence(`${start}\n${done.replace('residual=0', 'residual=1')}\n`, { cwd: repoRoot }))
      .toThrow('zero-residual contract');
  });

  test('distinguishes confirmed absence from daemon, permission, and timeout ambiguity', () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const name = 'masarx-pgtap-abc123';
    const expected = toolchainCli.expectedContainerIdentity({ loaded, imageId, phase: 'parallel_wave' });
    expect(toolchainCli.inspectExactContainer(name, expected, {
      spawnSyncImpl: () => ({ status: 1, stdout: '[]\n', stderr: `Error response from daemon: No such container: ${name}` }),
    })).toEqual({ state: 'absent' });
    expect(toolchainCli.inspectExactContainer(name, expected, {
      spawnSyncImpl: () => ({ status: 1, stdout: '[]\n', stderr: `Error response from daemon: No such container: ${name}-other` }),
    })).toMatchObject({ state: 'ambiguous', reason: 'inspect_failed' });
    expect(toolchainCli.inspectExactContainer(name, expected, {
      spawnSyncImpl: () => ({ status: 1, stdout: '', stderr: 'permission denied while trying to connect to the Docker daemon' }),
    })).toMatchObject({ state: 'ambiguous', reason: 'inspect_failed' });
    expect(toolchainCli.inspectExactContainer(name, expected, {
      spawnSyncImpl: () => ({ status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) }),
    })).toMatchObject({ state: 'ambiguous', reason: 'inspect_timeout' });
  });

  test('blocks forced cleanup when container identity does not match', () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const name = 'masarx-pgtap-abc123';
    const expected = toolchainCli.expectedContainerIdentity({ loaded, imageId, phase: 'parallel_wave' });
    const spawnSyncImpl = jest.fn(() => ({
      status: 0,
      stdout: validContainerInspect(name, expected, { labels: { 'org.masarx.phase': 'isolated_rerun' } }),
      stderr: '',
    }));
    expect(toolchainCli.removeExactContainer(name, expected, { spawnSyncImpl }))
      .toMatchObject({ state: 'ambiguous', reason: 'identity_mismatch' });
    expect(spawnSyncImpl).toHaveBeenCalledTimes(1);
  });

  test('bounds forced removal and proves exact zero residual after successful cleanup', async () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const name = 'masarx-pgtap-abc123';
    const expected = toolchainCli.expectedContainerIdentity({ loaded, imageId, phase: 'parallel_wave' });
    const calls = [];
    const spawnSyncImpl = jest.fn((command, args, options) => {
      calls.push({ command, args, timeout: options.timeout });
      if (args[0] === 'container') {
        const inspectCount = calls.filter((entry) => entry.args[0] === 'container').length;
        if (inspectCount === 1) return { status: 0, stdout: validContainerInspect(name, expected), stderr: '' };
        return { status: 1, stdout: '', stderr: `Error response from daemon: No such container: ${name}` };
      }
      return { status: 0, stdout: name, stderr: '' };
    });
    await expect(toolchainCli.cleanupExactContainer(name, expected, 5000, { spawnSyncImpl }))
      .resolves.toMatchObject({ removed: true, inspection: { state: 'absent' } });
    expect(calls.map((entry) => entry.args.slice(0, 2))).toEqual([
      ['container', 'inspect'],
      ['rm', '--force'],
      ['container', 'inspect'],
    ]);
    expect(calls[1].args[2]).toBe('b'.repeat(64));
    expect(calls.every((entry) => entry.timeout > 0 && entry.timeout <= 5000)).toBe(true);
  });

  test('fails closed when bounded forced removal times out', async () => {
    const loaded = toolchain.loadPolicy(repoRoot);
    const name = 'masarx-pgtap-abc123';
    const expected = toolchainCli.expectedContainerIdentity({ loaded, imageId, phase: 'parallel_wave' });
    const spawnSyncImpl = jest.fn((command, args) => {
      if (args[0] === 'container') return { status: 0, stdout: validContainerInspect(name, expected), stderr: '' };
      return { status: null, stdout: '', stderr: '', error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) };
    });
    await expect(toolchainCli.cleanupExactContainer(name, expected, 5000, { spawnSyncImpl }))
      .resolves.toMatchObject({ removed: false, inspection: { state: 'ambiguous', reason: 'remove_timeout' } });
  });
});
