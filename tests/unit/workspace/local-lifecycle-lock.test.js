const fs = require('fs');
const os = require('os');
const path = require('path');
const {
  acquireWorkspaceLifecycleLock,
  commitRuntimeOwnershipJournalReplace,
  inspectRuntimeOwnershipJournal,
  inspectWorkspaceLifecycleLock,
  reclaimStaleWorkspaceLifecycleLock,
  resolveProcessBirthIdentity,
  runtimeOwnershipJournalPath,
  workspaceLifecycleLockPath,
  writeRuntimeOwnershipJournalAtomic,
} = require('../../../scripts/ops/workspace/local-lifecycle-lock');
const { resolveWorkspaceRuntimeIdentity } = require('../../../scripts/ops/workspace/local-config');

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

const exactProcessIdentity = Object.freeze({
  bootIdentityImpl: () => 'boot-test',
  processBirthIdentityImpl: (pid) => (pid === process.pid ? 'birth-current-process' : ''),
});

describe('workspace local lifecycle lock', () => {
test('claimed stale lock can be quarantined with its zero-byte owner intact', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-quarantine-'));
    const lockDir = path.join(cwd, '.masarx-checkout-lifecycle.lock');
    const saved = path.join(cwd, 'quarantined.lock');
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), '', { mode: 0o600 });
      const nowMs = fs.statSync(lockDir).mtimeMs + 60000;
      const inspected = inspectWorkspaceLifecycleLock(lockDir, {
        nowMs, allowZeroByteOwnerQuarantine: true, quarantineStaleLockImpl: () => {},
      });
      const callback = jest.fn(({ claimPath, latest }) => {
        expect(latest.status).toBe('stale');
        expect(fs.readdirSync(lockDir).sort()).toEqual(['.reclaim-claim.json', 'owner.json']);
        expect(fs.existsSync(claimPath)).toBe(true);
        fs.renameSync(lockDir, saved);
      });
      expect(await reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
        nowMs, allowZeroByteOwnerQuarantine: true, quarantineStaleLockImpl: callback,
      })).toBe(true);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(fs.statSync(path.join(saved, 'owner.json')).size).toBe(0);
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test.each(['checkout', 'docker-runtime'])('old zero-byte %s owner remains stale after its own claim', async kind => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-owner-age-'));
    const lockDir = path.join(cwd, kind === 'checkout'
      ? '.masarx-checkout-lifecycle.lock' : 'exact-project.lock.docker-runtime');
    const archived = path.join(cwd, 'archived.lock');
    const ownerPath = path.join(lockDir, 'owner.json');
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(ownerPath, '', { mode: 0o600 });
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(ownerPath, old, old);
      const callback = jest.fn(({ latest, claimPath }) => {
        expect(latest).toMatchObject({ status: 'stale', reason: 'owner_metadata_missing_or_invalid' });
        expect(fs.readdirSync(lockDir).sort()).toEqual(['.reclaim-claim.json', 'owner.json']);
        expect(fs.existsSync(claimPath)).toBe(true);
        fs.renameSync(lockDir, archived);
      });
      const options = { allowZeroByteOwnerQuarantine: true, quarantineStaleLockImpl: callback };
      expect(inspectWorkspaceLifecycleLock(lockDir, options).status).toBe('stale');
      if (kind === 'checkout') {
        expect(() => inspectWorkspaceLifecycleLock(lockDir))
          .toThrow('docker_runtime_authority_file_invalid:owner.json');
      } else {
        expect(inspectWorkspaceLifecycleLock(lockDir).status).toBe('initializing');
      }
      expect(await reclaimStaleWorkspaceLifecycleLock(lockDir,
        inspectWorkspaceLifecycleLock(lockDir, options), options)).toBe(true);
      expect(callback).toHaveBeenCalledTimes(1);
      expect(fs.statSync(path.join(archived, 'owner.json')).size).toBe(0);
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(ownerPath, '', { mode: 0o600 });
      expect(inspectWorkspaceLifecycleLock(lockDir, options).status).toBe('initializing');
      expect(await reclaimStaleWorkspaceLifecycleLock(lockDir,
        inspectWorkspaceLifecycleLock(lockDir, options), options)).toBe(false);
      expect(fs.readdirSync(lockDir)).toEqual(['owner.json']);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('zero-byte owner replacement or foreign reclaim claim remains fail-closed', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-claim-negative-'));
    const lockDir = path.join(cwd, 'exact-project.lock.docker-runtime');
    const ownerPath = path.join(lockDir, 'owner.json');
    try {
      fs.mkdirSync(lockDir);
      fs.writeFileSync(ownerPath, '');
      const old = new Date(Date.now() - 60000);
      fs.utimesSync(ownerPath, old, old);
      const callback = jest.fn();
      const options = { allowZeroByteOwnerQuarantine: true, quarantineStaleLockImpl: callback };
      const inspected = inspectWorkspaceLifecycleLock(lockDir, options);
      fs.writeFileSync(path.join(lockDir, '.reclaim-claim.json'), '{}');
      expect(await reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, options)).toBe(false);
      expect(callback).not.toHaveBeenCalled();
      fs.rmSync(path.join(lockDir, '.reclaim-claim.json'));
      expect(await reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
        ...options, afterReclaimClaimImpl: () => fs.writeFileSync(ownerPath,
          JSON.stringify({ token: 'replacement', pid: process.pid })),
      })).toBe(false);
      expect(callback).not.toHaveBeenCalled();
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('rejected quarantine preserves the original lock', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-lock-quarantine-reject-'));
    const lockDir = path.join(cwd, '.masarx-checkout-lifecycle.lock');
    try {
      fs.mkdirSync(lockDir, { mode: 0o700 });
      fs.writeFileSync(path.join(lockDir, 'owner.json'), '', { mode: 0o600 });
      const nowMs = fs.statSync(lockDir).mtimeMs + 60000;
      const inspected = inspectWorkspaceLifecycleLock(lockDir, {
        nowMs, allowZeroByteOwnerQuarantine: true, quarantineStaleLockImpl: () => {},
      });
      await expect(reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
        nowMs, allowZeroByteOwnerQuarantine: true,
        quarantineStaleLockImpl: () => { throw new Error('identity changed'); },
      })).rejects.toThrow('identity changed');
      expect(fs.statSync(path.join(lockDir, 'owner.json')).size).toBe(0);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });
  test('checkout ownership reads and writes consistently use the supplied filesystem', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-fs-'));
    const fsImpl = { ...fs, lstatSync: jest.fn((...args) => fs.lstatSync(...args)),
      openSync: jest.fn((...args) => fs.openSync(...args)) };
    try {
      const held = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'fs', operation: 'fixture', fsImpl,
        stateRoot: path.join(cwd, 'state'),
      });
      held.release();
      expect(fsImpl.openSync.mock.calls.some(([file]) => String(file).includes('.masarx-checkout-lifecycle.lock'))).toBe(true);
      expect(fsImpl.lstatSync.mock.calls.some(([file]) => String(file).includes('.masarx-checkout-lifecycle.lock'))).toBe(true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test.each(['release', 'reclaim'])('checkout %s preserves a replacement directory even with copied owner metadata', async (operation) => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-replacement-'));
    const lockDir = path.join(cwd, '.masarx-checkout-lifecycle.lock');
    const saved = path.join(cwd, 'preserved-original-lock');
    try {
      const held = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'replace', operation: 'fixture', lockDir,
      });
      const replace = () => {
        fs.renameSync(lockDir, saved);
        fs.mkdirSync(lockDir, { mode: 0o700 });
        for (const name of fs.readdirSync(saved)) {
          fs.writeFileSync(path.join(lockDir, name), fs.readFileSync(path.join(saved, name)), { mode: 0o600 });
        }
        fs.writeFileSync(path.join(lockDir, 'preserved.txt'), 'replacement evidence');
      };
      if (operation === 'release') {
        replace();
        expect(() => held.release()).toThrow('directory identity changed before removal');
      } else {
        const ownerPath = path.join(lockDir, 'owner.json');
        const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
        fs.writeFileSync(ownerPath, JSON.stringify({ ...owner, pid: 999999 }), { mode: 0o600 });
        const processKillImpl = () => { const error = new Error('absent'); error.code = 'ESRCH'; throw error; };
        const inspected = inspectWorkspaceLifecycleLock(lockDir, { processKillImpl });
        await expect(reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
          processKillImpl, afterReclaimClaimImpl: replace,
        })).rejects.toThrow('directory identity changed before removal');
      }
      expect(fs.readFileSync(path.join(lockDir, 'preserved.txt'), 'utf8')).toBe('replacement evidence');
      expect(fs.existsSync(saved)).toBe(true);
    } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  });

  test('same physical checkout excludes another workspace even with a redirected ownership root', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-exclusion-'));
    let first;
    try {
      first = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'first', operation: 'fixture',
        stateRoot: path.join(cwd, 'first-state'),
      });
      let clock = 0;
      await expect(acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'second', operation: 'fixture',
        stateRoot: path.join(cwd, 'second-state'), waitMs: 1,
        nowImpl: () => clock, sleepImpl: async () => { clock += 2; },
      })).rejects.toThrow('timed out waiting for workspace lifecycle lock');
      first.release(); first = null;
      const second = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'second', operation: 'fixture',
        stateRoot: path.join(cwd, 'second-state'),
      });
      second.release();
      expect(fs.existsSync(path.join(cwd, '.masarx-checkout-lifecycle.lock'))).toBe(false);
    } finally {
      if (first) first.release();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('physical aliases share checkout exclusion while Docker outer lock remains separately nestable', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-alias-'));
    const cwd = path.join(root, 'real');
    const alias = path.join(root, 'alias');
    fs.mkdirSync(cwd);
    fs.symlinkSync(cwd, alias, 'junction');
    let outer; let held;
    try {
      outer = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'outer', operation: 'docker-up',
        lockDir: path.join(root, 'docker.lock'),
      });
      held = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'inner', operation: 'local-start',
        stateRoot: path.join(root, 'state'),
      });
      let clock = 0;
      await expect(acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd: alias, workspaceId: 'alias', operation: 'local-env',
        stateRoot: path.join(root, 'other-state'), waitMs: 1,
        nowImpl: () => clock, sleepImpl: async () => { clock += 2; },
      })).rejects.toThrow('timed out waiting for workspace lifecycle lock');
      expect(outer.lock_dirs).toEqual([path.join(root, 'docker.lock')]);
    } finally {
      if (held) held.release();
      if (outer) outer.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('checkout symlink cannot redirect lifecycle ownership into an unrelated directory', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-symlink-'));
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-checkout-unrelated-'));
    try {
      fs.writeFileSync(path.join(other, 'preserved.txt'), 'owned by another fixture');
      fs.symlinkSync(other, path.join(cwd, '.masarx-checkout-lifecycle.lock'), 'junction');
      await expect(acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity, cwd, workspaceId: 'symlink', operation: 'fixture',
        stateRoot: path.join(cwd, 'state'),
      })).rejects.toThrow('path_component_invalid');
      expect(fs.readFileSync(path.join(other, 'preserved.txt'), 'utf8')).toBe('owned by another fixture');
      expect(fs.readdirSync(other)).toEqual(['preserved.txt']);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
      fs.rmSync(other, { recursive: true, force: true });
    }
  });

  test('re-probes process birth identity on every check so PID reuse cannot inherit cached proof', () => {
    const spawnSyncImpl = jest
      .fn()
      .mockReturnValueOnce({ status: 0, stdout: '20260719010101.000000+000\r\n' })
      .mockReturnValueOnce({ status: 0, stdout: '20260719020202.000000+000\r\n' });
    expect(resolveProcessBirthIdentity(4242, { platform: 'win32', spawnSyncImpl }))
      .toBe('20260719010101.000000+000');
    expect(resolveProcessBirthIdentity(4242, { platform: 'win32', spawnSyncImpl }))
      .toBe('20260719020202.000000+000');
    expect(spawnSyncImpl).toHaveBeenCalledTimes(2);
  });

  test('recovers only after validating that the recorded owner process is stale', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-lifecycle-stale-'));
    const workspaceId = 'wk-stale-owner';
    const stateRoot = path.join(cwd, '.runtime-state');
    const lockDir = workspaceLifecycleLockPath(cwd, workspaceId, { stateRoot });
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      version: 1,
      token: 'stale-token',
      workspace_id: workspaceId,
      operation: 'local-start',
      pid: 999999,
      cwd,
      acquired_at: '2026-07-15T00:00:00.000Z',
    }), 'utf8');
    const processKillImpl = jest.fn(() => {
      const error = new Error('process not found');
      error.code = 'ESRCH';
      throw error;
    });

    try {
      expect(inspectWorkspaceLifecycleLock(lockDir, { processKillImpl }).status).toBe('stale');
      const lock = await acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity,
        cwd,
        workspaceId,
        operation: 'local-stop',
        processKillImpl,
        stateRoot,
        waitMs: 1000,
      });
      expect(lock.owner.operation).toBe('local-stop');
      expect(lock.owner.token).not.toBe('stale-token');
      lock.release();
      expect(fs.existsSync(lockDir)).toBe(false);
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('fails closed after the bounded wait while the recorded owner remains active', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-lifecycle-active-'));
    const workspaceId = 'wk-active-owner';
    const stateRoot = path.join(cwd, '.runtime-state');
    let nowMs = 1000;
    const ownerLock = await acquireWorkspaceLifecycleLock({
      ...exactProcessIdentity,
      cwd,
      workspaceId,
      operation: 'local-start',
      nowImpl: () => nowMs,
      waitMs: 100,
      stateRoot,
    });

    try {
      await expect(acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity,
        cwd,
        workspaceId,
        operation: 'local-stop',
        nowImpl: () => nowMs,
        waitMs: 10,
        retryMs: 5,
        sleepImpl: async (delayMs) => { nowMs += delayMs; },
        stateRoot,
      })).rejects.toThrow(/timed out waiting for workspace lifecycle lock.*local-start.*pid=/i);
      expect(inspectWorkspaceLifecycleLock(ownerLock.lock_dir, exactProcessIdentity).status).toBe('active');
    } finally {
      ownerLock.release();
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('an exclusive reclaim claim prevents two contenders from deleting an ABA replacement owner', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-lifecycle-aba-'));
    const workspaceId = 'wk-aba-owner';
    const stateRoot = path.join(cwd, '.runtime-state');
    const lockDir = workspaceLifecycleLockPath(cwd, workspaceId, { stateRoot });
    const ownerPath = path.join(lockDir, 'owner.json');
    const claimed = deferred();
    const resume = deferred();
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(ownerPath, JSON.stringify({
      version: 1,
      token: 'stale-token',
      workspace_id: workspaceId,
      operation: 'local-start',
      pid: 999999,
      cwd,
      acquired_at: '2026-07-15T00:00:00.000Z',
    }), 'utf8');
    const processKillImpl = jest.fn((pid) => {
      if (pid === process.pid) return;
      const error = new Error('process not found');
      error.code = 'ESRCH';
      throw error;
    });

    let first;
    try {
      const inspected = inspectWorkspaceLifecycleLock(lockDir, { ...exactProcessIdentity, processKillImpl });
      first = reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
        ...exactProcessIdentity,
        processKillImpl,
        afterReclaimClaimImpl: async () => {
          claimed.resolve();
          await resume.promise;
        },
      });
      first.catch(() => {});
      await claimed.promise;

      await expect(reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, {
        ...exactProcessIdentity,
        processKillImpl,
      }))
        .resolves.toBe(false);

      fs.rmSync(lockDir, { recursive: true, force: true });
      fs.mkdirSync(lockDir, { recursive: true });
      fs.writeFileSync(ownerPath, JSON.stringify({
        version: 1,
        token: 'replacement-active-token',
        workspace_id: workspaceId,
        operation: 'local-stop',
        pid: process.pid,
        cwd,
        acquired_at: '2026-07-15T01:00:00.000Z',
      }), 'utf8');

      resume.resolve();
      await expect(first).resolves.toBe(false);
      expect(inspectWorkspaceLifecycleLock(lockDir, { ...exactProcessIdentity, processKillImpl })).toEqual(expect.objectContaining({
        status: 'active',
        owner: expect.objectContaining({ token: 'replacement-active-token' }),
      }));
      expect(fs.existsSync(lockDir)).toBe(true);
    } finally {
      resume.resolve();
      await first?.catch(() => {});
      fs.rmSync(cwd, { recursive: true, force: true });
    }
  });

  test('serializes the same legacy Docker namespace across different worktree roots', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-lifecycle-global-'));
    const stateRoot = path.join(root, 'state');
    const workspaceId = 'wk-shared-namespace';
    fs.mkdirSync(path.join(root, 'worktree-a'));
    fs.mkdirSync(path.join(root, 'worktree-b'));
    const first = await acquireWorkspaceLifecycleLock({
      ...exactProcessIdentity,
      cwd: path.join(root, 'worktree-a'),
      workspaceId,
      operation: 'local-start',
      stateRoot,
      waitMs: 1000,
    });
    const waiting = deferred();
    const resume = deferred();
    let secondPromise;
    try {
      expect(first.lock_dirs).toHaveLength(3);
      expect(first.lock_dirs).toEqual([...first.lock_dirs].sort((a, b) => a.localeCompare(b)));
      secondPromise = acquireWorkspaceLifecycleLock({
        ...exactProcessIdentity,
        cwd: path.join(root, 'worktree-b'),
        workspaceId,
        operation: 'local-stop',
        stateRoot,
        waitMs: 5000,
        retryMs: 1,
        sleepImpl: async () => {
          waiting.resolve();
          await resume.promise;
        },
      });
      secondPromise.catch(() => {});
      await waiting.promise;
      first.release();
      resume.resolve();
      const second = await secondPromise;
      expect(second.lock_dirs).toHaveLength(3);
      second.release();
      secondPromise = null;
    } finally {
      resume.resolve();
      try { first.release(); } catch (_) { /* already released */ }
      await secondPromise?.then((lock) => lock.release()).catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('writes the ownership journal under the exact held lock and rejects an owner mismatch', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), '5ff747db-04ff-40d0-b8de-39cf5a08edf9-journal-'));
    const identity = resolveWorkspaceRuntimeIdentity('wk-journal-owner', { cwd: root });
    const journalPath = runtimeOwnershipJournalPath(identity, { stateRoot: path.join(root, 'state') });
    const initial = {
      version: 1,
      revision: 1,
      generation: 1,
      owner_id: identity.owner_id,
      workspace_id: identity.workspace_id,
      project_id: identity.project_id,
      state: 'created_this_invocation',
    };
    const lifecycleLock = await acquireWorkspaceLifecycleLock({
      ...exactProcessIdentity,
      cwd: root,
      workspaceId: identity.workspace_id,
      operation: 'journal-test',
      runtimeIdentity: identity,
      stateRoot: path.join(root, 'state'),
    });
    const openSyncSpy = jest.spyOn(fs, 'openSync');
    try {
      const written = writeRuntimeOwnershipJournalAtomic(journalPath, initial, {
        ...exactProcessIdentity,
        platform: 'win32',
        expectedDigest: null,
        expectedGeneration: 0,
        lifecycleLock,
        atomicReplaceImpl: (source, target) => fs.renameSync(source, target),
      });
      expect(written.status).toBe('valid');
      expect(openSyncSpy).toHaveBeenCalledWith(journalPath, 'r+');
      expect(inspectRuntimeOwnershipJournal(journalPath)).toEqual(expect.objectContaining({
        status: 'valid',
        journal: expect.objectContaining({ owner_id: identity.owner_id, revision: 1 }),
      }));
      expect(() => writeRuntimeOwnershipJournalAtomic(journalPath, {
        ...initial,
        revision: 2,
      }, {
        ...exactProcessIdentity,
        expectedDigest: written.digest,
        expectedGeneration: 2,
        lifecycleLock,
      })).toThrow(/generation CAS mismatch/i);
      expect(() => writeRuntimeOwnershipJournalAtomic(journalPath, {
        ...initial,
        revision: 2,
      }, {
        ...exactProcessIdentity,
        expectedDigest: written.digest,
        expectedGeneration: 1,
      })).toThrow(/requires an exact held lifecycle lock/i);
      expect(() => writeRuntimeOwnershipJournalAtomic(journalPath, {
        ...initial,
        revision: 2,
        owner_id: 'foreign-owner',
      }, {
        ...exactProcessIdentity,
        expectedDigest: written.digest,
        expectedGeneration: 1,
        lifecycleLock,
      })).toThrow(/owner mismatch/i);
    } finally {
      openSyncSpy.mockRestore();
      lifecycleLock.release();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses Windows WRITE_THROUGH atomic replacement without interpolating journal paths into script', () => {
    const spawnSyncImpl = jest.fn(() => ({ status: 0, stdout: '', stderr: '' }));
    commitRuntimeOwnershipJournalReplace('C:\\state\\temp journal.json', 'C:\\state\\journal.json', {
      platform: 'win32',
      spawnSyncImpl,
    });
    expect(spawnSyncImpl).toHaveBeenCalledWith(
      'powershell.exe',
      expect.arrayContaining(['-NoProfile', '-NonInteractive', '-Command']),
      expect.objectContaining({
        windowsHide: true,
        env: expect.objectContaining({
          MASARX_JOURNAL_TEMP_PATH: 'C:\\state\\temp journal.json',
          MASARX_JOURNAL_TARGET_PATH: 'C:\\state\\journal.json',
        }),
      }),
    );
    const command = spawnSyncImpl.mock.calls[0][1].at(-1);
    expect(command).toContain('MoveFileEx');
    expect(command).toContain(',9)');
    expect(command).not.toContain('temp journal.json');
  });

  test('treats PID reuse as stale only when boot and process birth evidence proves replacement', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-local-lifecycle-pid-reuse-'));
    const lockDir = path.join(root, 'lock');
    fs.mkdirSync(lockDir);
    fs.writeFileSync(path.join(lockDir, 'owner.json'), JSON.stringify({
      version: 3,
      token: 'lease-one',
      lease_id: 'lease-one',
      owner_id: 'owner-one',
      pid: 4242,
      process_birth_id: 'birth-original',
      boot_id: 'boot-current',
    }), 'utf8');
    try {
      const inspected = inspectWorkspaceLifecycleLock(lockDir, {
        bootIdentityImpl: () => 'boot-current',
        processBirthIdentityImpl: () => 'birth-reused-pid',
        processKillImpl: () => undefined,
      });
      expect(inspected).toEqual(expect.objectContaining({
        status: 'stale',
        reason: 'owner_process_birth_changed',
      }));
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
