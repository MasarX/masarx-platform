/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const {
  drainIngressRedaction,
  fetchAuthoritativeBase,
  parseArgs,
  resolveBatchTimeouts,
  runCandidateProof,
  validateBatchResult,
  writeCandidateProof,
} = require('../../../scripts/ops/backfill-ingress-persisted-redaction');

function createCandidateRepository(tempDir) {
  const cwd = path.join(tempDir, 'worktree');
  const hooks = path.join(tempDir, 'hooks');
  fs.mkdirSync(cwd);
  fs.mkdirSync(hooks);
  const excludesFile = path.join(tempDir, 'excludes');
  fs.writeFileSync(excludesFile, '');
  const git = (args) => execFileSync('git', [
    '-c', 'user.name=Unit fixture',
    '-c', 'user.email=unit-fixture@example.invalid',
    '-c', 'commit.gpgsign=false',
    '-c', `core.hooksPath=${hooks}`,
    ...args,
  ], { cwd, encoding: 'utf8' });
  git(['init', '-b', 'fixture']);
  git(['config', 'core.excludesFile', excludesFile]);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'base\n');
  fs.writeFileSync(path.join(cwd, 'deleted.txt'), 'deleted in candidate\n');
  git(['add', '.']);
  git(['commit', '-m', 'base fixture']);
  const baseSha = git(['rev-parse', 'HEAD']).trim();
  git(['update-ref', 'refs/remotes/origin/dev', baseSha]);
  fs.writeFileSync(path.join(cwd, 'fixture.txt'), 'candidate\n');
  fs.unlinkSync(path.join(cwd, 'deleted.txt'));
  git(['add', '-A']);
  git(['commit', '-m', 'candidate fixture']);
  fs.appendFileSync(path.join(cwd, 'fixture.txt'), 'worktree edit\n');
  fs.writeFileSync(path.join(cwd, 'untracked.txt'), 'untracked fixture\n');
  return { cwd, baseSha };
}

function makeClient(batchResults, options = {}) {
  const queries = [];
  let batchIndex = 0;
  const stream = { destroy: jest.fn() };
  const client = {
    connection: { stream },
    connect: options.connectError
      ? jest.fn().mockRejectedValue(options.connectError)
      : jest.fn().mockResolvedValue(undefined),
    end: options.endError
      ? jest.fn().mockRejectedValue(options.endError)
      : jest.fn().mockResolvedValue(undefined),
    query: jest.fn(async (query, params) => {
      const config = typeof query === 'string' ? { text: query, values: params } : query;
      const { text } = config;
      queries.push(config);
      if (text.includes('pg_try_advisory_lock')) {
        return { rows: [{ acquired: options.lockAcquired !== false }] };
      }
      if (text.includes('pg_advisory_unlock') && options.unlockError) throw options.unlockError;
      if (text === 'ROLLBACK' && options.rollbackError) throw options.rollbackError;
      if (text === 'COMMIT' && options.commitError) throw options.commitError;
      if (text === 'BEGIN' || text === 'COMMIT' || text === 'ROLLBACK' || text.startsWith('SET LOCAL')) {
        return { rows: [] };
      }
      if (text.includes('backfill_ingress_persisted_redaction_v1')) {
        const result = batchResults[batchIndex];
        batchIndex += 1;
        if (result instanceof Error) throw result;
        return { rows: [{ result }] };
      }
      if (text.includes('pg_advisory_unlock')) return { rows: [{ pg_advisory_unlock: true }] };
      throw new Error(`Unexpected query: ${text}`);
    }),
  };
  return { client, queries, stream };
}

describe('ingress persisted redaction backfill drain', () => {
  test('parses bounded command arguments', () => {
    expect(parseArgs(['--batch-size', '250', '--max-batches', '20', '--max-duration-ms', '5000', '--json']))
      .toMatchObject({
        batchSize: 250,
        maxBatches: 20,
        maxDurationMs: 5000,
        connectionTimeoutMs: 10000,
        statementTimeoutMs: 120000,
        lockTimeoutMs: 5000,
        queryGraceMs: 5000,
        cleanupReserveMs: 5000,
        rollbackTimeoutMs: 4000,
        proofFetchTimeoutMs: 120000,
        proofCommandTimeoutMs: 1800000,
        candidateProof: false,
        json: true,
      });
    expect(() => parseArgs(['--batch-size', '2001'])).toThrow('--batch-size');
    expect(() => parseArgs(['--unknown'])).toThrow('Missing value');
  });

  test('derives layered timeouts from the remaining monotonic deadline', () => {
    expect(resolveBatchTimeouts(20000, {
      cleanupReserveMs: 2000,
      statementTimeoutMs: 10000,
      lockTimeoutMs: 1000,
      queryGraceMs: 2000,
    })).toEqual({
      cleanupReserveMs: 2000,
      lockTimeoutMs: 1000,
      statementTimeoutMs: 10000,
      queryTimeoutMs: 12000,
    });
    expect(() => resolveBatchTimeouts(3000, {
      cleanupReserveMs: 2000,
      queryGraceMs: 1000,
    })).toThrow('no safe batch window');
  });

  test('drains until authoritative has_more is false and aggregates dynamic tables', async () => {
    const { client, queries } = makeClient([
      { has_more: true, updated: { webhook_inbox: 2, outbound_calls: 1 } },
      { has_more: false, updated: { webhook_inbox: 1, outbound_calls: 0 } },
    ]);
    let clock = 1000;
    const result = await drainIngressRedaction({
      connectionString: 'postgres://example',
      batchSize: 5,
      clientFactory: () => client,
      now: () => clock += 10,
      logger: { error: jest.fn() },
    });

    expect(result.status).toBe('complete');
    expect(result.batches).toBe(2);
    expect(result.updated).toEqual({ webhook_inbox: 3, outbound_calls: 1 });
    expect(queries.filter(({ text }) => text.includes('backfill_ingress_persisted_redaction_v1'))).toHaveLength(2);
    expect(queries.filter(({ text }) => text === 'BEGIN')).toHaveLength(2);
    expect(queries.filter(({ text }) => text === 'COMMIT')).toHaveLength(2);
    expect(queries.filter(({ text }) => text.startsWith('SET LOCAL lock_timeout'))).toHaveLength(2);
    expect(queries.filter(({ text }) => text.startsWith('SET LOCAL statement_timeout'))).toHaveLength(2);
    for (const query of queries.filter(({ text }) => text.includes('backfill_ingress_persisted_redaction_v1'))) {
      expect(query.query_timeout).toBeGreaterThan(0);
    }
    expect(queries.at(-1).text).toContain('pg_advisory_unlock');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test('binds the pg connection and every batch to explicit layered timeouts', async () => {
    const { client, queries } = makeClient([{ has_more: false, updated: {} }]);
    const clientFactory = jest.fn(() => client);
    await drainIngressRedaction({
      connectionString: 'postgres://example',
      connectionTimeoutMs: 4321,
      statementTimeoutMs: 20000,
      lockTimeoutMs: 2000,
      queryGraceMs: 3000,
      cleanupReserveMs: 4000,
      clientFactory,
      logger: { error: jest.fn() },
    });
    expect(clientFactory).toHaveBeenCalledWith({
      connectionString: 'postgres://example',
      connectionTimeoutMillis: 4321,
    });
    const lockSet = queries.find(({ text }) => text.startsWith('SET LOCAL lock_timeout'));
    const statementSet = queries.find(({ text }) => text.startsWith('SET LOCAL statement_timeout'));
    const batchQuery = queries.find(({ text }) => text.includes('backfill_ingress_persisted_redaction_v1'));
    expect(lockSet.text).toContain('2000ms');
    expect(statementSet.text).toContain('20000ms');
    expect(batchQuery.query_timeout).toBeGreaterThan(20000);
  });

  test('caps a hanging connection to the remaining overall deadline before cleanup reserve', async () => {
    jest.useFakeTimers();
    try {
      const { client, stream } = makeClient([]);
      client.connect = jest.fn(() => new Promise(() => {}));
      const clientFactory = jest.fn(() => client);
      const pending = drainIngressRedaction({
        connectionString: 'postgres://example',
        maxDurationMs: 6000,
        cleanupReserveMs: 5000,
        connectionTimeoutMs: 10000,
        clientFactory,
        now: () => 1000,
        logger: { error: jest.fn() },
      });
      const rejection = expect(pending).rejects.toMatchObject({ backendTermination: 'socket_destroyed' });
      await jest.advanceTimersByTimeAsync(1000);
      await rejection;
      expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ connectionTimeoutMillis: 1000 }));
      expect(stream.destroy).toHaveBeenCalledTimes(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test('rejects an overall duration that cannot preserve cleanup reserve before connecting', async () => {
    const clientFactory = jest.fn();
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      maxDurationMs: 4000,
      cleanupReserveMs: 5000,
      clientFactory,
      logger: { error: jest.fn() },
    })).rejects.toThrow('must exceed the cleanup reserve');
    expect(clientFactory).not.toHaveBeenCalled();
  });

  test('fails closed when another drain owns the lock', async () => {
    const { client } = makeClient([], { lockAcquired: false });
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger: { error: jest.fn() },
    })).rejects.toThrow('owns the advisory lock');
    expect(client.end).toHaveBeenCalledTimes(1);
    expect(client.query.mock.calls.some(([query]) => query.text?.includes('pg_advisory_unlock'))).toBe(false);
  });

  test('destroys a partially opened client when connection establishment fails', async () => {
    const { client, stream } = makeClient([], { connectError: new Error('connection timeout') });
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger: { error: jest.fn() },
    })).rejects.toMatchObject({ backendTermination: 'socket_destroyed' });
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
  });

  test('releases ownership after a batch failure', async () => {
    const { client, queries } = makeClient([new Error('database failed')]);
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger: { error: jest.fn() },
    })).rejects.toThrow('database failed');
    expect(queries.at(-1).text).toContain('pg_advisory_unlock');
    expect(client.end).toHaveBeenCalledTimes(1);
  });

  test('does not advance committed counts when COMMIT fails and rolls back cleanly', async () => {
    const { client, queries, stream } = makeClient([
      { has_more: false, updated: { webhook_inbox: 3 } },
    ], { commitError: new Error('commit failed') });
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger: { error: jest.fn() },
    })).rejects.toThrow('commit failed');
    expect(queries.some(({ text }) => text === 'ROLLBACK')).toBe(true);
    expect(stream.destroy).not.toHaveBeenCalled();
  });

  test('destroys the connection and records backend termination when rollback fails', async () => {
    const logger = { error: jest.fn() };
    const { client, stream } = makeClient([new Error('query timed out')], {
      rollbackError: new Error('rollback timed out'),
    });
    const error = await drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger,
    }).catch((failure) => failure);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toContain('backend socket_destroyed');
    expect(error).toMatchObject({ backendTermination: 'socket_destroyed' });
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('backend_termination=socket_destroyed'));
  });

  test('fails closed and destroys the connection when advisory unlock cannot complete', async () => {
    const logger = { error: jest.fn() };
    const { client, stream } = makeClient([{ has_more: false, updated: {} }], {
      unlockError: new Error('unlock timed out'),
    });
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger,
    })).rejects.toMatchObject({ backendTermination: 'socket_destroyed' });
    expect(stream.destroy).toHaveBeenCalledTimes(1);
    expect(client.end).not.toHaveBeenCalled();
  });

  test('fails closed and destroys the connection when graceful close cannot complete', async () => {
    const logger = { error: jest.fn() };
    const { client, stream } = makeClient([{ has_more: false, updated: {} }], {
      endError: new Error('close failed'),
    });
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      clientFactory: () => client,
      logger,
    })).rejects.toMatchObject({ backendTermination: 'socket_destroyed' });
    expect(stream.destroy).toHaveBeenCalledTimes(1);
  });

  test('rejects malformed results and configured caps', async () => {
    expect(() => validateBatchResult({ has_more: 'yes', updated: {} })).toThrow('boolean has_more');
    expect(() => validateBatchResult({ has_more: false, updated: { rows: -1 } })).toThrow('invalid updated count');

    const { client } = makeClient([{ has_more: true, updated: {} }]);
    await expect(drainIngressRedaction({
      connectionString: 'postgres://example',
      maxBatches: 1,
      clientFactory: () => client,
      logger: { error: jest.fn() },
    })).rejects.toThrow('exceeded max batches');
  });

  test('binds proof to exact git, command, tool, environment, output, and file identity', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-ingress-proof-'));
    const outputPath = path.join(tempDir, 'result.json');
    const testResult = {
      numTotalTestSuites: 2,
      numPassedTestSuites: 2,
      numFailedTestSuites: 0,
      numTotalTests: 28,
      numPassedTests: 28,
      numFailedTests: 0,
      success: true,
    };
    const commandRunner = jest.fn(() => ({
      status: 0,
      signal: null,
      error: null,
      stdout: Buffer.from(JSON.stringify(testResult)),
      stderr: Buffer.from(''),
    }));
    try {
      const { cwd, baseSha } = createCandidateRepository(tempDir);
      const expectedStatusV2Z = execFileSync(
        'git',
        ['status', '--porcelain=v2', '-z', '--untracked-files=all'],
        { cwd },
      );
      const remoteVerifier = jest.fn(() => ({
        remote: 'origin',
        branch: 'dev',
        remote_url: 'https://github.com/MasarX/MasarX.git',
        remote_url_sha256: 'a'.repeat(64),
        remote_ref: 'refs/remotes/origin/dev',
        sha: baseSha,
        refspec: '+refs/heads/dev:refs/remotes/origin/dev',
        fetch_started_at: '2026-07-19T00:00:00.000Z',
        fetch_finished_at: '2026-07-19T00:00:01.000Z',
        fetch_stdout_sha256: 'b'.repeat(64),
        fetch_timeout_ms: 120000,
      }));
      const proof = runCandidateProof({
        cwd,
        baseSha,
        testCommand: 'npm run test:unit -- ingress-redaction',
        testOutput: outputPath,
        commandRunner,
        remoteVerifier,
      });
      expect(commandRunner).toHaveBeenCalledWith(
        'npm run test:unit -- ingress-redaction',
        cwd,
        { timeoutMs: 1800000 },
      );
      expect(remoteVerifier).toHaveBeenCalledTimes(2);
      expect(proof.git.common_dir).toBeTruthy();
      expect(proof.git.base_ref).toBe('refs/remotes/origin/dev');
      expect(proof.git.status_v2_z_base64).toBe(expectedStatusV2Z.toString('base64'));
      expect(proof.git.base_to_head_diff_binary_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.git.worktree_diff_binary_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.git.files.length).toBeGreaterThan(0);
      expect(proof.git.files.some((file) => file.tracked)).toBe(true);
      expect(proof.git.files.some((file) => !file.tracked)).toBe(true);
      expect(proof.git.deleted).toEqual([expect.objectContaining({ path: 'deleted.txt' })]);
      expect(proof.git.files.filter((file) => file.tracked).every((file) => /^100[67][0-7]{2}$/.test(file.index_mode))).toBe(true);
      expect(proof.git.files.filter((file) => file.tracked).every((file) => /^[0-9a-f]{40,64}$/.test(file.index_object_sha))).toBe(true);
      expect(proof.git.files.filter((file) => !file.tracked).every((file) => file.index_mode === null)).toBe(true);
      expect(proof.git.files.filter((file) => !file.tracked).every((file) => file.index_object_sha === null)).toBe(true);
      expect(proof.proof.command_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.proof.output_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.proof.environment_hashes.aggregate_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.proof.counts).toMatchObject({ tests_total: 28, tests_passed: 28, success: true });
      expect(proof.proof.execution).toMatchObject({ exit_code: 0, command: 'npm run test:unit -- ingress-redaction' });
      expect(proof.proof.causality.pre_candidate_git_sha256)
        .toBe(proof.proof.causality.post_candidate_git_sha256);
      expect(proof.proof.causality.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(proof.proof.authority).toMatchObject({
        remote_url: 'https://github.com/MasarX/MasarX.git',
        sha: baseSha,
      });
      expect(proof.candidate_identity_sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({
        exit_code: 0,
        stdout_sha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      const proofPath = path.join(tempDir, 'proof.json');
      expect(writeCandidateProof(proof, proofPath, cwd)).toBe(proofPath);
      expect(JSON.parse(fs.readFileSync(proofPath, 'utf8')).candidate_identity_sha256)
        .toBe(proof.candidate_identity_sha256);
      expect(() => writeCandidateProof(proof, path.join(cwd, 'unignored-proof.json'), cwd))
        .toThrow('cannot invalidate candidate identity');
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('production proof runner executes the exact command and preserves its real output', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-ingress-real-proof-'));
    const outputPath = path.join(tempDir, 'result.json');
    try {
      const { cwd, baseSha } = createCandidateRepository(tempDir);
      const proof = runCandidateProof({
        cwd,
        baseSha,
        testCommand: 'git --version',
        testOutput: outputPath,
        remoteVerifier: () => ({
          remote: 'origin',
          branch: 'dev',
          remote_url: 'https://github.com/MasarX/MasarX.git',
          remote_url_sha256: 'a'.repeat(64),
          remote_ref: 'refs/remotes/origin/dev',
          sha: baseSha,
          refspec: '+refs/heads/dev:refs/remotes/origin/dev',
          fetch_started_at: '2026-07-19T00:00:00.000Z',
          fetch_finished_at: '2026-07-19T00:00:01.000Z',
          fetch_stdout_sha256: 'b'.repeat(64),
          fetch_timeout_ms: 120000,
        }),
      });
      const envelope = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(proof.proof.execution).toMatchObject({ exit_code: 0, command: 'git --version' });
      expect(Buffer.from(envelope.stdout_base64, 'base64').toString('utf8')).toMatch(/^git version /);
      expect(envelope.stdout_sha256).toBe(proof.proof.execution.stdout_sha256);
      expect(proof.proof.causality.receipt_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });

  test('freshly fetches and binds the authoritative remote dev ref', () => {
    const baseSha = '1'.repeat(40);
    const gitRunner = jest.fn((args) => {
      if (args.join(' ') === 'remote get-url origin') return 'https://github.com/MasarX/MasarX.git\n';
      if (args[0] === 'fetch') return Buffer.from('fetched');
      if (args[0] === 'rev-parse') return `${baseSha}\n`;
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    const receipt = fetchAuthoritativeBase({ cwd: process.cwd(), gitRunner, timeoutMs: 5000 });
    expect(receipt).toMatchObject({
      remote: 'origin',
      branch: 'dev',
      remote_url: 'https://github.com/MasarX/MasarX.git',
      remote_ref: 'refs/remotes/origin/dev',
      sha: baseSha,
      fetch_timeout_ms: 5000,
    });
    expect(gitRunner).toHaveBeenCalledWith([
      'fetch', '--no-tags', '--prune', 'origin', '+refs/heads/dev:refs/remotes/origin/dev',
    ], process.cwd(), null, 5000);
  });

  test('fails closed when remote dev moves and records bounded command timeout', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-ingress-timeout-proof-'));
    const outputPath = path.join(tempDir, 'result.json');
    const { cwd, baseSha } = createCandidateRepository(tempDir);
    const authority = (sha) => ({
      remote: 'origin', branch: 'dev', remote_url: 'https://github.com/MasarX/MasarX.git',
      remote_url_sha256: 'a'.repeat(64), remote_ref: 'refs/remotes/origin/dev', sha,
      refspec: '+refs/heads/dev:refs/remotes/origin/dev', fetch_started_at: 'start',
      fetch_finished_at: 'finish', fetch_stdout_sha256: 'b'.repeat(64), fetch_timeout_ms: 120000,
    });
    const remoteVerifier = jest.fn()
      .mockReturnValueOnce(authority(baseSha))
      .mockReturnValueOnce(authority('2'.repeat(40)));
    try {
      expect(() => runCandidateProof({
        cwd,
        baseSha,
        testCommand: 'slow command',
        testOutput: outputPath,
        proofCommandTimeoutMs: 5000,
        remoteVerifier,
        commandRunner: jest.fn(() => ({
          status: null,
          signal: 'SIGTERM',
          error: Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }),
          stdout: Buffer.alloc(0),
          stderr: Buffer.from('timeout'),
        })),
      })).toThrow('Authoritative remote dev moved');
      expect(JSON.parse(fs.readFileSync(outputPath, 'utf8'))).toMatchObject({
        timed_out: true,
        timeout_ms: 5000,
        spawn_error: 'timed out',
      });
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
});
