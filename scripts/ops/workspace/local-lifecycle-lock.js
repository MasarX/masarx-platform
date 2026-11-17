#!/usr/bin/env node
/* eslint-disable no-console */
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const { resolveWorkspaceRuntimeIdentity, normalizeWorkspaceRuntimeRoot } = require('./local-config');
const {
  assertNoSymlinkPathComponents, assertOwnedDirectory, readStableAuthorityFile,
} = require('./docker-runtime/authority');
const CHECKOUT_LOCK_NAME = '.masarx-checkout-lifecycle.lock';

function isCheckoutLockDir(directory) {
  return path.basename(directory) === CHECKOUT_LOCK_NAME;
}

function assertCheckoutLockPath(directory, fsImpl = fs) {
  assertNoSymlinkPathComponents(directory, { fsImpl });
  assertOwnedDirectory(path.dirname(directory), { label: 'checkout', fsImpl });
  if (fsImpl.existsSync(directory)) {
    return assertOwnedDirectory(directory, { mode: process.platform === 'win32' ? null : 0o700, label: 'checkout_lock', fsImpl });
  }
}

const DEFAULT_WAIT_MS = 120000;
const DEFAULT_RETRY_MS = 250;
const DEFAULT_OWNER_INIT_GRACE_MS = 5000;
const RUNTIME_OWNERSHIP_JOURNAL_VERSION = 1;
const bootIdentityCache = new Map();

function parsePositiveInt(value, fallback) {
  const parsed = Number.parseInt(String(value || '').trim(), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function hasAutoOverlayMarkers(toml) {
  return /^# AUTO-OVERLAY-BEGIN/m.test(String(toml || ''))
    && /^# AUTO-OVERLAY-END /m.test(String(toml || ''));
}

function hasAnyAutoOverlayMarker(toml) {
  return /^# AUTO-OVERLAY-(?:BEGIN|END)(?:\s|:)/m.test(String(toml || ''));
}

function readJson(file, fsImpl = fs) {
  if (isCheckoutLockDir(path.dirname(file))) {
    assertCheckoutLockPath(path.dirname(file), fsImpl);
    try {
      fsImpl.lstatSync(file);
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    return JSON.parse(readStableAuthorityFile(file, 256 * 1024, null, { fsImpl }).bytes.toString('utf8'));
  }
  try {
    return JSON.parse(fsImpl.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

function processExists(pid, processKillImpl = process.kill) {
  const parsed = Number.parseInt(String(pid || '').trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return false;
  try {
    processKillImpl(parsed, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

function resolveBootIdentity(options = {}) {
  if (typeof options.bootIdentityImpl === 'function') {
    return String(options.bootIdentityImpl(options) || '').trim();
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  if (bootIdentityCache.has(platform)) return bootIdentityCache.get(platform);
  const fsImpl = options.fsImpl || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  let value = '';
  try {
    if (platform === 'linux') {
      value = String(fsImpl.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8') || '').trim();
    } else if (platform === 'win32') {
      const script = [
        '$value=(Get-CimInstance Win32_OperatingSystem -Property LastBootUpTime).LastBootUpTime',
        "if($null -ne $value){$value.ToUniversalTime().ToString('o')}",
      ].join(';');
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result?.status === 0) value = String(result.stdout || '').trim();
    } else {
      const result = spawnSyncImpl('sysctl', ['-n', 'kern.boottime'], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result?.status === 0) value = String(result.stdout || '').trim();
    }
  } catch (_) {
    value = '';
  }
  if (value) bootIdentityCache.set(platform, value);
  return value;
}

function resolveProcessBirthIdentity(pid, options = {}) {
  const parsedPid = Number.parseInt(String(pid || '').trim(), 10);
  if (!Number.isFinite(parsedPid) || parsedPid <= 0) return '';
  if (typeof options.processBirthIdentityImpl === 'function') {
    return String(options.processBirthIdentityImpl(parsedPid, options) || '').trim();
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  const fsImpl = options.fsImpl || fs;
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  let value = '';
  try {
    if (platform === 'linux') {
      const stat = String(fsImpl.readFileSync(`/proc/${parsedPid}/stat`, 'utf8') || '');
      const closeParen = stat.lastIndexOf(')');
      const fields = closeParen >= 0 ? stat.slice(closeParen + 1).trim().split(/\s+/) : [];
      value = String(fields[19] || '').trim();
    } else if (platform === 'win32') {
      const script = [
        `$value=(Get-CimInstance Win32_Process -Filter \"ProcessId = ${parsedPid}\" -Property CreationDate).CreationDate`,
        "if($null -ne $value){$value.ToUniversalTime().ToString('o')}",
      ].join(';');
      const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result?.status === 0) value = String(result.stdout || '').trim();
    } else {
      const result = spawnSyncImpl('ps', ['-o', 'lstart=', '-p', String(parsedPid)], {
        encoding: 'utf8',
        windowsHide: true,
      });
      if (result?.status === 0) value = String(result.stdout || '').trim();
    }
  } catch (_) {
    value = '';
  }
  return value;
}

function resolveRuntimeOwnershipStateRoot(options = {}) {
  const env = options.env || process.env;
  const configured = options.stateRoot || env.MASARX_RUNTIME_OWNERSHIP_STATE_ROOT;
  if (String(configured || '').trim()) return path.resolve(String(configured).trim());
  const localRoot = env.LOCALAPPDATA || env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.resolve(localRoot, 'MasarX', 'runtime-ownership');
}

function namespacePathSegment(namespace) {
  const raw = String(namespace || '').trim();
  const safe = (raw || 'workspace')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'workspace';
  const digest = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 32);
  return `${safe}-${digest}`;
}

function workspaceLifecycleLockPaths(cwd, workspaceId, options = {}) {
  if (options.lockDir) return [path.resolve(options.lockDir)];
  const identity = options.runtimeIdentity || resolveWorkspaceRuntimeIdentity(workspaceId, {
    cwd,
    platform: options.platform,
    realpathSyncImpl: options.realpathSyncImpl,
  });
  const stateRoot = resolveRuntimeOwnershipStateRoot(options);
  return Array.from(new Set([
    path.join(normalizeWorkspaceRuntimeRoot(cwd, {
      realpathSyncImpl: options.realpathSyncImpl || options.fsImpl?.realpathSync,
    }), CHECKOUT_LOCK_NAME),
    ...[
    identity.project_id,
    identity.legacy_project_id,
  ].filter(Boolean).map((namespace) => (
    path.join(stateRoot, 'locks', `${namespacePathSegment(namespace)}.lock`)
  )),])).sort((left, right) => left.localeCompare(right));
}

function workspaceLifecycleLockPath(cwd, workspaceId, options = {}) {
  const paths = workspaceLifecycleLockPaths(cwd, workspaceId, options);
  return paths.find((directory) => !isCheckoutLockDir(directory)) || paths[0];
}

function runtimeOwnershipJournalPath(runtimeIdentity, options = {}) {
  if (!runtimeIdentity?.owner_id) {
    throw new Error('runtime ownership journal requires an owner identity');
  }
  return path.join(
    resolveRuntimeOwnershipStateRoot(options),
    'journals',
    `${namespacePathSegment(runtimeIdentity.owner_id)}.json`,
  );
}

function journalDigest(raw) {
  return crypto.createHash('sha256').update(String(raw || '')).digest('hex');
}

function inspectRuntimeOwnershipJournal(journalPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!fsImpl.existsSync(journalPath)) {
    return { status: 'absent', path: journalPath, journal: null, digest: null, raw: '' };
  }
  let raw;
  try {
    raw = fsImpl.readFileSync(journalPath, 'utf8');
  } catch (error) {
    return { status: 'unreadable', path: journalPath, journal: null, digest: null, raw: '', error };
  }
  try {
    const journal = JSON.parse(raw);
    if (
      journal?.version !== RUNTIME_OWNERSHIP_JOURNAL_VERSION ||
      !String(journal.owner_id || '').trim() ||
      !Number.isInteger(journal.generation) ||
      journal.generation <= 0 ||
      !Number.isInteger(journal.revision) ||
      journal.revision <= 0
    ) {
      return { status: 'invalid', path: journalPath, journal, digest: journalDigest(raw), raw };
    }
    return { status: 'valid', path: journalPath, journal, digest: journalDigest(raw), raw };
  } catch (error) {
    return { status: 'invalid', path: journalPath, journal: null, digest: journalDigest(raw), raw, error };
  }
}

function commitRuntimeOwnershipJournalReplace(tempPath, journalPath, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (typeof options.atomicReplaceImpl === 'function') {
    options.atomicReplaceImpl(tempPath, journalPath, options);
    return;
  }
  const platform = String(options.platform || process.platform).toLowerCase();
  if (platform !== 'win32') {
    fsImpl.renameSync(tempPath, journalPath);
    return;
  }
  const spawnSyncImpl = options.spawnSyncImpl || spawnSync;
  const script = [
    "Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MasarXAtomicMove { [DllImport(\"kernel32.dll\", CharSet=CharSet.Unicode, SetLastError=true)] public static extern bool MoveFileEx(string existingName, string newName, int flags); }'",
    '$ok=[MasarXAtomicMove]::MoveFileEx($env:MASARX_JOURNAL_TEMP_PATH,$env:MASARX_JOURNAL_TARGET_PATH,9)',
    'if(-not $ok){exit [Runtime.InteropServices.Marshal]::GetLastWin32Error()}',
  ].join(';');
  const result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      MASARX_JOURNAL_TEMP_PATH: tempPath,
      MASARX_JOURNAL_TARGET_PATH: journalPath,
    },
  });
  if (result?.status !== 0) {
    throw new Error(
      `runtime ownership journal WRITE_THROUGH atomic replace failed: ${journalPath}; ` +
      `${String(result?.stderr || result?.stdout || `status=${result?.status ?? 'unknown'}`).trim()}`,
    );
  }
}

function writeRuntimeOwnershipJournalAtomic(journalPath, journal, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (
    journal?.version !== RUNTIME_OWNERSHIP_JOURNAL_VERSION ||
    !String(journal.owner_id || '').trim() ||
    !Number.isInteger(journal.generation) ||
    journal.generation <= 0 ||
    !Number.isInteger(journal.revision) ||
    journal.revision <= 0
  ) {
    throw new Error('refusing to write invalid runtime ownership journal');
  }

  const before = inspectRuntimeOwnershipJournal(journalPath, { fsImpl });
  const expectedDigest = options.expectedDigest === undefined ? before.digest : options.expectedDigest;
  const expectedGeneration = options.expectedGeneration === undefined
    ? (before.journal?.generation || 0)
    : options.expectedGeneration;
  if (expectedDigest === null && before.status !== 'absent') {
    throw new Error(`runtime ownership journal CAS expected absence: ${journalPath}`);
  }
  if (expectedDigest !== null && before.digest !== expectedDigest) {
    throw new Error(`runtime ownership journal CAS digest mismatch: ${journalPath}`);
  }
  if (before.journal && before.journal.owner_id !== journal.owner_id) {
    throw new Error(`runtime ownership journal owner mismatch: ${journalPath}`);
  }
  if ((before.journal?.generation || 0) !== expectedGeneration) {
    throw new Error(`runtime ownership journal generation CAS mismatch: ${journalPath}`);
  }
  if (before.journal && ![before.journal.generation, before.journal.generation + 1].includes(journal.generation)) {
    throw new Error(`runtime ownership journal generation must remain or advance exactly once: ${journalPath}`);
  }
  if (before.journal && journal.revision <= before.journal.revision) {
    throw new Error(`runtime ownership journal revision must advance: ${journalPath}`);
  }
  assertLifecycleLockProof(options.lifecycleLock, journal.owner_id, {
    ...options,
    fsImpl,
  });

  const directory = path.dirname(journalPath);
  fsImpl.mkdirSync(directory, { recursive: true });
  const token = crypto.randomBytes(16).toString('hex');
  const tempPath = path.join(directory, `.${path.basename(journalPath)}.${process.pid}.${token}.tmp`);
  const raw = `${JSON.stringify(journal, null, 2)}\n`;
  let tempFd = null;
  try {
    tempFd = fsImpl.openSync(tempPath, 'wx', 0o600);
    fsImpl.writeFileSync(tempFd, raw, { encoding: 'utf8' });
    fsImpl.fsyncSync(tempFd);
    fsImpl.closeSync(tempFd);
    tempFd = null;
    if (typeof options.beforeCommitImpl === 'function') {
      options.beforeCommitImpl({ before, journal, journalPath, tempPath });
    }
    assertLifecycleLockProof(options.lifecycleLock, journal.owner_id, {
      ...options,
      fsImpl,
    });
    const current = inspectRuntimeOwnershipJournal(journalPath, { fsImpl });
    if (current.digest !== before.digest || current.status !== before.status) {
      throw new Error(`runtime ownership journal changed before atomic commit: ${journalPath}`);
    }
    if ((current.journal?.generation || 0) !== expectedGeneration) {
      throw new Error(`runtime ownership journal generation changed before atomic commit: ${journalPath}`);
    }
    commitRuntimeOwnershipJournalReplace(tempPath, journalPath, { ...options, fsImpl });
    // FlushFileBuffers requires a writable Windows handle. The temp file was
    // already fsynced and MoveFileExW used WRITE_THROUGH; this post-commit
    // flush keeps the committed file durable without weakening POSIX fsync.
    const committedOpenMode = String(options.platform || process.platform).toLowerCase() === 'win32'
      ? 'r+'
      : 'r';
    const committedFd = fsImpl.openSync(journalPath, committedOpenMode);
    try {
      fsImpl.fsyncSync(committedFd);
    } finally {
      fsImpl.closeSync(committedFd);
    }
    if (typeof options.syncDirectoryImpl === 'function') {
      options.syncDirectoryImpl(directory, { ...options, fsImpl });
    } else if (String(options.platform || process.platform).toLowerCase() !== 'win32') {
      const directoryFd = fsImpl.openSync(directory, 'r');
      try {
        fsImpl.fsyncSync(directoryFd);
      } finally {
        fsImpl.closeSync(directoryFd);
      }
    }
  } finally {
    if (tempFd !== null) {
      try { fsImpl.closeSync(tempFd); } catch (_) { /* best effort close before exact temp cleanup */ }
    }
    if (fsImpl.existsSync(tempPath)) fsImpl.rmSync(tempPath, { force: true });
  }
  return inspectRuntimeOwnershipJournal(journalPath, { fsImpl });
}

function assertLifecycleLockProof(lifecycleLock, expectedOwnerId, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const owner = lifecycleLock?.owner;
  const lockDirs = lifecycleLock?.lock_dirs;
  if (
    !owner ||
    !String(owner.token || '').trim() ||
    owner.lease_id !== owner.token ||
    !String(owner.process_birth_id || '').trim() ||
    !String(owner.boot_id || '').trim() ||
    owner.pid !== process.pid ||
    owner.owner_id !== expectedOwnerId ||
    !Array.isArray(lockDirs) ||
    lockDirs.length === 0
  ) {
    throw new Error('runtime ownership journal mutation requires an exact held lifecycle lock');
  }
  const currentBootId = resolveBootIdentity(options);
  const currentProcessBirthId = resolveProcessBirthIdentity(process.pid, options);
  if (currentBootId !== owner.boot_id || currentProcessBirthId !== owner.process_birth_id) {
    throw new Error('runtime ownership journal lifecycle lock process identity no longer matches');
  }
  for (const lockDir of lockDirs) {
    const current = readJson(path.join(lockDir, 'owner.json'), fsImpl);
    if (
      !current ||
      current.token !== owner.token ||
      current.lease_id !== owner.lease_id ||
      current.pid !== owner.pid ||
      current.process_birth_id !== owner.process_birth_id ||
      current.boot_id !== owner.boot_id ||
      current.owner_id !== expectedOwnerId
    ) {
      throw new Error(`runtime ownership lifecycle lock changed or is not held: ${lockDir}`);
    }
  }
  return true;
}

function sameCheckoutDirectory(left, right) {
  return Boolean(left && right && left.dev === right.dev && left.ino === right.ino && left.uid === right.uid);
}

function removeCheckoutDirectory(lockDir, expected, fsImpl) {
  const current = assertCheckoutLockPath(lockDir, fsImpl);
  if (!sameCheckoutDirectory(expected, current)) {
    throw new Error('checkout lifecycle lock directory identity changed before removal');
  }
  fsImpl.rmSync(lockDir, { recursive: true, force: true });
}

function inspectWorkspaceLifecycleLock(lockDir, options = {}) {
  if (!isCheckoutLockDir(lockDir)) return inspectWorkspaceLifecycleLockState(lockDir, options);
  const fsImpl = options.fsImpl || fs;
  const before = assertCheckoutLockPath(lockDir, fsImpl);
  const inspected = inspectWorkspaceLifecycleLockState(lockDir, options);
  const after = assertCheckoutLockPath(lockDir, fsImpl);
  if ((before || after) && !sameCheckoutDirectory(before, after)) {
    throw new Error('checkout lifecycle lock directory changed during inspection');
  }
  return { ...inspected, checkout_identity: after };
}

function inspectWorkspaceLifecycleLockState(lockDir, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (!fsImpl.existsSync(lockDir)) return { status: 'free', lock_dir: lockDir };

  const ownerPath = path.join(lockDir, 'owner.json');
  let zeroByteOwner = false;
  if (isCheckoutLockDir(lockDir) && options.allowZeroByteOwnerQuarantine) {
    if (typeof options.quarantineStaleLockImpl !== 'function') {
      throw new Error('checkout zero-byte owner requires quarantine callback');
    }
    const stat = fsImpl.lstatSync(ownerPath);
    zeroByteOwner = stat.isFile() && !stat.isSymbolicLink() && stat.size === 0
      && stat.uid === process.getuid();
    if (stat.size === 0 && !zeroByteOwner) {
      throw new Error('checkout zero-byte owner identity invalid');
    }
  }
  const owner = zeroByteOwner ? null : readJson(ownerPath, fsImpl);
  let ageMs = null;
  try {
    ageMs = Math.max(0, Number(options.nowMs ?? Date.now()) - fsImpl.statSync(lockDir).mtimeMs);
  } catch (_) {
    // A concurrent release is equivalent to a free lock on the next acquisition attempt.
  }

  if (!owner || !owner.token) {
    // A quarantine claim changes the directory mtime, not the damaged owner file.
    // This opt-in path still requires the caller's explicit quarantine callback.
    if (options.allowZeroByteOwnerQuarantine
      && typeof options.quarantineStaleLockImpl === 'function') {
      try {
        const ownerStat = fsImpl.lstatSync(ownerPath);
        if (ownerStat.isFile() && !ownerStat.isSymbolicLink()
          && ownerStat.uid === process.getuid() && ownerStat.size === 0) {
          ageMs = Math.max(0, Number(options.nowMs ?? Date.now()) - ownerStat.mtimeMs);
        }
      } catch (_) {
        // A missing or changed owner keeps the ordinary directory grace period.
      }
    }
    const graceMs = parsePositiveInt(options.ownerInitGraceMs, DEFAULT_OWNER_INIT_GRACE_MS);
    return {
      status: ageMs != null && ageMs >= graceMs ? 'stale' : 'initializing',
      lock_dir: lockDir,
      owner: owner || null,
      age_ms: ageMs,
      reason: 'owner_metadata_missing_or_invalid',
    };
  }

  const active = processExists(owner.pid, options.processKillImpl);
  if (!active) {
    return {
      status: 'stale',
      lock_dir: lockDir,
      owner,
      age_ms: ageMs,
      reason: 'owner_process_absent',
    };
  }
  if (
    owner.lease_id !== owner.token ||
    !String(owner.process_birth_id || '').trim() ||
    !String(owner.boot_id || '').trim()
  ) {
    return {
      status: 'active',
      lock_dir: lockDir,
      owner,
      age_ms: ageMs,
      reason: 'owner_identity_unverifiable',
    };
  }
  const currentBootId = resolveBootIdentity(options);
  const currentProcessBirthId = resolveProcessBirthIdentity(owner.pid, options);
  if (!currentBootId || !currentProcessBirthId) {
    return {
      status: 'active',
      lock_dir: lockDir,
      owner,
      age_ms: ageMs,
      reason: 'owner_identity_probe_failed_closed',
    };
  }
  const sameBoot = currentBootId === owner.boot_id;
  const sameProcessBirth = currentProcessBirthId === owner.process_birth_id;
  return {
    status: sameBoot && sameProcessBirth ? 'active' : 'stale',
    lock_dir: lockDir,
    owner,
    age_ms: ageMs,
    reason: sameBoot && sameProcessBirth
      ? 'owner_process_identity_active'
      : (!sameBoot ? 'owner_boot_identity_changed' : 'owner_process_birth_changed'),
  };
}

async function reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, options = {}) {
  const fsImpl = options.fsImpl || fs;
  if (inspected?.status !== 'stale') return false;

  const claimPath = path.join(lockDir, '.reclaim-claim.json');
  const claim = {
    version: 1,
    token: crypto.randomBytes(16).toString('hex'),
    pid: process.pid,
    expected_owner_token: inspected.owner?.token || '',
    claimed_at: new Date(options.nowMs ?? Date.now()).toISOString(),
  };
  try {
    fsImpl.writeFileSync(claimPath, `${JSON.stringify(claim, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      ...(isCheckoutLockDir(lockDir) ? { mode: 0o600 } : {}),
    });
  } catch (error) {
    if (error?.code === 'EEXIST' || error?.code === 'ENOENT') return false;
    throw error;
  }

  if (typeof options.afterReclaimClaimImpl === 'function') {
    await options.afterReclaimClaimImpl({ claim, claimPath, inspected, lockDir });
  }

  const currentClaim = readJson(claimPath, fsImpl);
  if (!currentClaim || currentClaim.token !== claim.token) return false;
  const latest = inspectWorkspaceLifecycleLock(lockDir, options);
  const expectedToken = inspected.owner?.token || '';
  const latestToken = latest.owner?.token || '';
  if (
    latest.status !== 'stale' ||
    expectedToken !== latestToken ||
    inspected.owner?.lease_id !== latest.owner?.lease_id ||
    inspected.owner?.process_birth_id !== latest.owner?.process_birth_id ||
    inspected.owner?.boot_id !== latest.owner?.boot_id
  ) return false;
  const finalClaim = readJson(claimPath, fsImpl);
  if (!finalClaim || finalClaim.token !== claim.token) return false;

  if (typeof options.quarantineStaleLockImpl === 'function') {
    await options.quarantineStaleLockImpl({ lockDir, inspected, latest, claim, claimPath });
    return true;
  }
  if (isCheckoutLockDir(lockDir)) {
    removeCheckoutDirectory(lockDir, inspected.checkout_identity, fsImpl);
  } else {
    fsImpl.rmSync(lockDir, { recursive: true, force: true });
  }
  return true;
}

async function acquireSingleWorkspaceLifecycleLock(lockDir, ownerBase, options = {}) {
  const fsImpl = options.fsImpl || fs;
  const nowImpl = options.nowImpl || Date.now;
  const sleepImpl = options.sleepImpl || sleep;
  const retryMs = options.retryMs;
  const deadline = options.deadline;
  const ownerPath = path.join(lockDir, 'owner.json');
  if (isCheckoutLockDir(lockDir)) assertCheckoutLockPath(lockDir, fsImpl);
  fsImpl.mkdirSync(path.dirname(lockDir), { recursive: true });

  while (true) {
    if (isCheckoutLockDir(lockDir)) assertCheckoutLockPath(lockDir, fsImpl);
    try {
      fsImpl.mkdirSync(lockDir, isCheckoutLockDir(lockDir) ? { mode: 0o700 } : undefined);
      const owner = { ...ownerBase, lock_dir: lockDir };
      const tempOwnerPath = path.join(lockDir, `.owner.${ownerBase.token}.tmp`);
      fsImpl.writeFileSync(tempOwnerPath, `${JSON.stringify(owner, null, 2)}\n`, {
        encoding: 'utf8',
        flag: 'wx',
        ...(isCheckoutLockDir(lockDir) ? { mode: 0o600 } : {}),
      });
      fsImpl.renameSync(tempOwnerPath, ownerPath);
      const checkoutIdentity = isCheckoutLockDir(lockDir)
        ? assertCheckoutLockPath(lockDir, fsImpl) : null;
      return { lockDir, owner, ownerPath, checkoutIdentity };
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      const inspected = inspectWorkspaceLifecycleLock(lockDir, {
        ...options,
        fsImpl,
        nowMs: nowImpl(),
      });
      if (await reclaimStaleWorkspaceLifecycleLock(lockDir, inspected, { ...options, fsImpl })) {
        continue;
      }
      if (nowImpl() >= deadline) {
        const owner = inspected.owner || {};
        throw new Error(
          `timed out waiting for workspace lifecycle lock (${ownerBase.operation} blocked by ${owner.operation || inspected.status}` +
          `${owner.pid ? ` pid=${owner.pid}` : ''}): ${lockDir}`,
        );
      }
      await sleepImpl(retryMs, inspected);
    }
  }
}

async function acquireWorkspaceLifecycleLock(options = {}) {
  const cwd = path.resolve(options.cwd || process.cwd());
  const workspaceId = String(options.workspaceId || '').trim();
  const operation = String(options.operation || '').trim();
  if (!workspaceId) throw new Error('workspace lifecycle lock requires a workspace id');
  if (!operation) throw new Error('workspace lifecycle lock requires an operation');

  const fsImpl = options.fsImpl || fs;
  const env = options.env || process.env;
  const waitMs = parsePositiveInt(options.waitMs ?? env.WORKSPACE_LOCAL_LIFECYCLE_LOCK_WAIT_MS, DEFAULT_WAIT_MS);
  const retryMs = parsePositiveInt(options.retryMs ?? env.WORKSPACE_LOCAL_LIFECYCLE_LOCK_RETRY_MS, DEFAULT_RETRY_MS);
  const nowImpl = options.nowImpl || Date.now;
  const runtimeIdentity = options.runtimeIdentity || resolveWorkspaceRuntimeIdentity(workspaceId, {
    cwd,
    platform: options.platform,
    realpathSyncImpl: options.realpathSyncImpl,
  });
  const lockDirs = options.lockDir
    ? [path.resolve(options.lockDir)]
    : workspaceLifecycleLockPaths(cwd, workspaceId, { ...options, runtimeIdentity });
  const deadline = nowImpl() + waitMs;
  const leaseId = crypto.randomBytes(16).toString('hex');
  const bootId = resolveBootIdentity({ ...options, fsImpl });
  const processBirthId = resolveProcessBirthIdentity(process.pid, { ...options, fsImpl });
  if (!bootId || !processBirthId) {
    throw new Error('workspace lifecycle lock cannot prove current boot and process birth identity');
  }
  const ownerBase = {
    version: 3,
    token: leaseId,
    lease_id: leaseId,
    workspace_id: workspaceId,
    owner_id: runtimeIdentity.owner_id,
    project_id: runtimeIdentity.project_id,
    legacy_project_id: runtimeIdentity.legacy_project_id,
    operation,
    pid: process.pid,
    process_birth_id: processBirthId,
    boot_id: bootId,
    cwd,
    acquired_at: new Date(nowImpl()).toISOString(),
  };
  const acquired = [];
  try {
    for (const lockDir of lockDirs) {
      acquired.push(await acquireSingleWorkspaceLifecycleLock(lockDir, ownerBase, {
        ...options,
        fsImpl,
        deadline,
        retryMs,
      }));
    }
  } catch (error) {
    for (const item of acquired.reverse()) {
      const latest = readJson(item.ownerPath, fsImpl);
      if (
        latest?.token === ownerBase.token &&
        latest?.lease_id === ownerBase.lease_id &&
        latest?.pid === process.pid &&
        latest?.process_birth_id === ownerBase.process_birth_id &&
        latest?.boot_id === ownerBase.boot_id
      ) {
        if (isCheckoutLockDir(item.lockDir)) {
          removeCheckoutDirectory(item.lockDir, item.checkoutIdentity, fsImpl);
        } else {
          fsImpl.rmSync(item.lockDir, { recursive: true, force: true });
        }
      }
    }
    throw error;
  }

  let released = false;
  return {
    lock_dir: acquired[0].lockDir,
    lock_dirs: acquired.map((item) => item.lockDir),
    owner: acquired[0].owner,
    runtime_identity: runtimeIdentity,
    release() {
      if (released) return;
      for (const item of [...acquired].reverse()) {
        const latest = readJson(item.ownerPath, fsImpl);
        if (
          !latest ||
          latest.token !== ownerBase.token ||
          latest.lease_id !== ownerBase.lease_id ||
          latest.pid !== process.pid ||
          latest.process_birth_id !== ownerBase.process_birth_id ||
          latest.boot_id !== ownerBase.boot_id
        ) {
          throw new Error(`workspace lifecycle lock ownership changed before release: ${item.lockDir}`);
        }
      }
      for (const item of [...acquired].reverse()) {
        if (isCheckoutLockDir(item.lockDir)) {
          removeCheckoutDirectory(item.lockDir, item.checkoutIdentity, fsImpl);
        } else {
          fsImpl.rmSync(item.lockDir, { recursive: true, force: true });
        }
      }
      released = true;
    },
  };
}

module.exports = {
  acquireWorkspaceLifecycleLock,
  assertLifecycleLockProof,
  commitRuntimeOwnershipJournalReplace,
  DEFAULT_OWNER_INIT_GRACE_MS,
  DEFAULT_RETRY_MS,
  DEFAULT_WAIT_MS,
  hasAnyAutoOverlayMarker,
  hasAutoOverlayMarkers,
  inspectRuntimeOwnershipJournal,
  inspectWorkspaceLifecycleLock,
  processExists,
  resolveBootIdentity,
  resolveProcessBirthIdentity,
  reclaimStaleWorkspaceLifecycleLock,
  resolveRuntimeOwnershipStateRoot,
  runtimeOwnershipJournalPath,
  RUNTIME_OWNERSHIP_JOURNAL_VERSION,
  workspaceLifecycleLockPath,
  workspaceLifecycleLockPaths,
  writeRuntimeOwnershipJournalAtomic,
};
