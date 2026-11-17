const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DEFAULT_LEASE_TTL_MS = 8 * 60 * 60 * 1000;
const LOCK_STALE_MS = 2 * 60 * 1000;
const ALLOCATION_STATES = Object.freeze({
  ACTIVE: 'active', REMOVED: 'removed', RESERVED: 'reserved', STARTING: 'starting',
  STOP_FAILED: 'stop_failed', STOP_REQUESTED: 'stop_requested',
});

class AndroidLeaseStoreReadError extends Error {
  constructor(filePath, reason) {
    super(`Android emulator lease store is unreadable or malformed: ${filePath}. ${reason}. Preserve it and route recovery to the main orchestrator.`);
    this.name = 'AndroidLeaseStoreReadError';
    this.code = 'ANDROID_EMULATOR_LEASE_STORE_UNREADABLE';
    this.filePath = filePath;
    this.reason = reason;
  }
}


function serialToConsolePort(serial) {
  const match = /^emulator-(\d+)$/i.exec(String(serial || '').trim());
  if (!match) return 0;
  return Number.parseInt(match[1], 10);
}

function sanitizeOwner(owner) {
  const cleaned = String(owner || '')
    .trim()
    .replace(/[^A-Za-z0-9._:@/-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  if (!cleaned) {
    throw new Error('Missing --owner. Use a branch/worktree/lane id.');
  }
  return cleaned.slice(0, 160);
}

function leaseStorePath(leaseDir) {
  return path.join(leaseDir, 'leases.json');
}

function readLeaseStore(leaseDir) {
  const filePath = leaseStorePath(leaseDir);
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { version: 1, leases: [] };
    throw new AndroidLeaseStoreReadError(filePath, error?.message || 'Unable to read store file');
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new AndroidLeaseStoreReadError(filePath, error?.message || 'Unable to parse JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new AndroidLeaseStoreReadError(filePath, 'Expected a JSON object with version and leases');
  }
  if (!Array.isArray(parsed.leases)) {
    throw new AndroidLeaseStoreReadError(filePath, 'Expected leases to be an array');
  }
  if (Object.prototype.hasOwnProperty.call(parsed, 'version') && parsed.version !== 1) {
    throw new AndroidLeaseStoreReadError(filePath, 'Unsupported lease store version');
  }
  for (const lease of parsed.leases) {
    const state = String(lease?.allocation_state ?? '').trim();
    if (state && !Object.values(ALLOCATION_STATES).includes(state)) {
      throw new AndroidLeaseStoreReadError(filePath, 'Unsupported explicit allocation state');
    }
  }
  return {
    version: 1,
    leases: parsed.leases,
  };
}

function writeLeaseStore(leaseDir, store) {
  fs.mkdirSync(leaseDir, { recursive: true });
  const target = leaseStorePath(leaseDir);
  const tmp = `${target}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, target);
}

function withLeaseLock(leaseDir, fn) {
  fs.mkdirSync(leaseDir, { recursive: true });
  const lockDir = path.join(leaseDir, '.lock');
  const start = Date.now();
  while (Date.now() - start < 10000) {
    try {
      fs.mkdirSync(lockDir);
      try {
        return fn();
      } finally {
        fs.rmSync(lockDir, { recursive: true, force: true });
      }
    } catch (error) {
      if (error && error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockDir);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockDir, { recursive: true, force: true });
          continue;
        }
      } catch {
        continue;
      }
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    }
  }
  throw new Error(`Timed out waiting for emulator lease lock: ${lockDir}`);
}

function allocationState(lease) {
  const explicit = String(lease?.allocation_state || '').trim();
  if (explicit) return explicit;
  const legacyRelease = String(lease?.release_state || '').trim();
  if (legacyRelease === ALLOCATION_STATES.STOP_FAILED) return ALLOCATION_STATES.STOP_FAILED;
  if (legacyRelease) return ALLOCATION_STATES.STOP_REQUESTED;
  return String(lease?.serial || '').trim() ? ALLOCATION_STATES.ACTIVE : ALLOCATION_STATES.RESERVED;
}

function isRecoverableAllocationState(state) {
  return [
    ALLOCATION_STATES.RESERVED,
    ALLOCATION_STATES.STARTING,
    ALLOCATION_STATES.STOP_REQUESTED,
    ALLOCATION_STATES.STOP_FAILED,
  ].includes(String(state || '').trim());
}

function findOwnedAllocation(store, { owner, avdName, serial = '' }) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedAvd = String(avdName || '').trim();
  const normalizedSerial = String(serial || '').trim();
  const matches = (store.leases || []).filter((lease) => (
    String(lease?.owner || '').trim() === normalizedOwner
    && String(lease?.avd_name || '').trim() === normalizedAvd
  ));
  if (matches.length > 1) {
    throw new Error(`Ambiguous Android allocation for ${normalizedOwner}/${normalizedAvd}; found ${matches.length} records.`);
  }
  const existing = matches[0] || null;
  return existing && (!normalizedSerial || String(existing.serial || '').trim() === normalizedSerial)
    ? existing : null;
}

function reserveAllocation({
  leaseDir,
  avdName,
  owner,
  ttlMs,
  beforeSerials = [],
  beforeProcessIds = [],
  cwd = process.cwd(),
}) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedAvd = String(avdName || '').trim();
  if (!normalizedAvd) throw new Error('Missing AVD name for allocation reservation.');
  return withLeaseLock(leaseDir, () => {
    // Reservation has no verified stop evidence; retain every allocation not explicitly removed.
    const pruned = { leases: readLeaseStore(leaseDir).leases.filter((lease) => (
      allocationState(lease) !== ALLOCATION_STATES.REMOVED
    )) };
    const collision = pruned.leases.find((lease) => (
      String(lease?.avd_name || '').trim() === normalizedAvd
      || (String(lease?.owner || '').trim() === normalizedOwner && allocationState(lease) !== ALLOCATION_STATES.REMOVED)
    ));
    if (collision) {
      throw new Error(
        `Android allocation already exists for owner/AVD ${collision.owner}/${collision.avd_name} in state ${allocationState(collision)}; reconcile it before reuse.`,
      );
    }
    const now = new Date();
    const reservation = {
      allocation_generation: crypto.randomUUID(),
      serial: '',
      console_port: 0,
      adb_port: 0,
      avd_name: normalizedAvd,
      owner: normalizedOwner,
      allocation_state: ALLOCATION_STATES.RESERVED,
      before_serials: [...new Set(beforeSerials.map((value) => String(value || '').trim()).filter(Boolean))],
      before_process_ids: [...new Set(beforeProcessIds.map((value) => Number.parseInt(String(value), 10)).filter((value) => Number.isFinite(value) && value > 0))],
      cwd,
      pid: process.pid,
      created_at: now.toISOString(),
      updated_at: now.toISOString(),
      heartbeat_at: now.toISOString(),
      expires_at: new Date(now.getTime() + (ttlMs || DEFAULT_LEASE_TTL_MS)).toISOString(),
    };
    writeLeaseStore(leaseDir, {
      version: 1,
      leases: [...pruned.leases, reservation].sort((a, b) => (
        `${a.owner}/${a.avd_name}/${a.serial}`.localeCompare(`${b.owner}/${b.avd_name}/${b.serial}`)
      )),
    });
    return reservation;
  });
}

function transitionOwnedAllocation({
  leaseDir,
  owner,
  avdName,
  expectedStates,
  nextState,
  serial,
  updates = {},
  error = '',
}) {
  // The lifecycle caller must verify OS launch/stop evidence; this store enforces durable identity.
  const allowed = new Set((expectedStates || []).map((state) => String(state || '').trim()));
  return withLeaseLock(leaseDir, () => {
    const store = readLeaseStore(leaseDir);
    const existing = findOwnedAllocation(store, { owner, avdName });
    if (!existing) throw new Error(`No durable Android allocation exists for ${sanitizeOwner(owner)}/${avdName}.`);
    const currentState = allocationState(existing);
    if (!allowed.has(currentState)) {
      throw new Error(
        `Invalid Android allocation transition for ${existing.owner}/${existing.avd_name}: ${currentState} -> ${nextState}.`,
      );
    }
    const validNextStates = {
      [ALLOCATION_STATES.RESERVED]: [ALLOCATION_STATES.STARTING, ALLOCATION_STATES.STOP_REQUESTED],
      [ALLOCATION_STATES.STARTING]: [ALLOCATION_STATES.STARTING, ALLOCATION_STATES.ACTIVE, ALLOCATION_STATES.STOP_REQUESTED],
      [ALLOCATION_STATES.ACTIVE]: [ALLOCATION_STATES.STOP_REQUESTED],
      [ALLOCATION_STATES.STOP_REQUESTED]: [ALLOCATION_STATES.STOP_REQUESTED, ALLOCATION_STATES.STOP_FAILED],
      [ALLOCATION_STATES.STOP_FAILED]: [ALLOCATION_STATES.STOP_REQUESTED, ALLOCATION_STATES.STOP_FAILED],
    };
    if (!(validNextStates[currentState] || []).includes(nextState)) {
      throw new Error(`Disallowed Android allocation state transition: ${currentState} -> ${nextState}.`);
    }
    for (const field of Object.keys(updates)) {
      if (!['launch_pid', 'owned_process_identities'].includes(field)) {
        throw new Error(`Refusing to patch protected Android allocation field ${field}.`);
      }
    }
    if (Object.keys(updates).length && currentState !== ALLOCATION_STATES.STARTING
      && nextState !== ALLOCATION_STATES.STARTING) {
      throw new Error('Launch metadata may only be recorded while starting.');
    }
    if (existing.launch_pid && Object.prototype.hasOwnProperty.call(updates, 'launch_pid')
      && updates.launch_pid !== existing.launch_pid) {
      throw new Error('Refusing to change the Android allocation launch PID.');
    }
    const normalizedSerial = serial === undefined
      ? String(existing.serial || '').trim()
      : String(serial || '').trim();
    if (serial !== undefined && existing.serial && String(existing.serial).trim() !== normalizedSerial) {
      throw new Error(
        `Refusing to change Android allocation serial from ${existing.serial} to ${normalizedSerial || '<empty>'}.`,
      );
    }
    if (nextState === ALLOCATION_STATES.ACTIVE && !normalizedSerial) {
      throw new Error('Active Android allocation requires an exact serial.');
    }
    if (normalizedSerial && store.leases.some((lease) => lease !== existing
      && String(lease?.serial || '').trim() === normalizedSerial)) {
      throw new Error(`Android serial ${normalizedSerial} has another allocation.`);
    }
    const lineage = updates.owned_process_identities === undefined
      ? existing.owned_process_identities : updates.owned_process_identities;
    if (Object.prototype.hasOwnProperty.call(updates, 'owned_process_identities')
      || nextState === ALLOCATION_STATES.ACTIVE) {
      if (!Array.isArray(lineage)) throw new Error('Android allocation requires a process identity array.');
      const fields = ['pid', 'parent_pid', 'creation_date', 'executable_path', 'command_line', 'avd_name'];
      const identities = new Map();
      for (const identity of lineage) {
        if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0
          || !Number.isSafeInteger(identity.parent_pid) || identity.parent_pid < 0
          || fields.slice(2).some((field) => typeof identity[field] !== 'string'
            || !identity[field].trim() || identity[field] !== identity[field].trim())
          || identity.avd_name !== existing.avd_name || identities.has(identity.pid)) {
          throw new Error('Incomplete or ambiguous Android process identity.');
        }
        identities.set(identity.pid, JSON.stringify(fields.map((field) => identity[field])));
      }
      for (const prior of existing.owned_process_identities || []) {
        if (identities.get(prior.pid) !== JSON.stringify(fields.map((field) => prior[field]))) {
          throw new Error('Refusing to remove or replace recorded Android process identity.');
        }
      }
      if (nextState === ALLOCATION_STATES.ACTIVE && identities.size === 0) {
        throw new Error('Active Android allocation requires nonempty process lineage.');
      }
    }
    const now = new Date().toISOString();
    const updated = {
      ...existing,
      ...updates,
      serial: normalizedSerial,
      console_port: serialToConsolePort(normalizedSerial),
      adb_port: serialToConsolePort(normalizedSerial) ? serialToConsolePort(normalizedSerial) + 1 : 0,
      allocation_state: nextState,
      updated_at: now,
    };
    delete updated.release_state;
    delete updated.release_updated_at;
    if (error) updated.allocation_error = String(error);
    else delete updated.allocation_error;
    writeLeaseStore(leaseDir, {
      version: 1,
      leases: [
        ...(store.leases || []).filter((lease) => lease !== existing),
        updated,
      ].sort((a, b) => `${a.owner}/${a.avd_name}/${a.serial}`.localeCompare(`${b.owner}/${b.avd_name}/${b.serial}`)),
    });
    return updated;
  });
}

function closeOwnedAllocation({ leaseDir, owner, avdName, serial = '' }) {
  return withLeaseLock(leaseDir, () => {
    const store = readLeaseStore(leaseDir);
    const existing = findOwnedAllocation(store, { owner, avdName, serial });
    if (!existing) throw new Error(`No durable Android allocation exists for ${sanitizeOwner(owner)}/${avdName}.`);
    if (existing.serial && String(existing.serial).trim() !== String(serial || '').trim()) {
      throw new Error('Closing a serial-bound allocation requires its exact serial.');
    }
    if (allocationState(existing) !== ALLOCATION_STATES.STOP_REQUESTED) {
      throw new Error(`Android allocation must be stop_requested before removal; found ${allocationState(existing)}.`);
    }
    const removed = {
      ...existing,
      allocation_state: ALLOCATION_STATES.REMOVED,
      updated_at: new Date().toISOString(),
    };
    writeLeaseStore(leaseDir, {
      version: 1,
      leases: (store.leases || []).filter((lease) => lease !== existing),
    });
    return removed;
  });
}

function pruneLeases(store, activeSerials, now = new Date()) {
  const active = new Set(activeSerials);
  const nowMs = now.getTime();
  return {
    version: 1,
    leases: store.leases.filter((lease) => {
      if (!lease || typeof lease !== 'object') return false;
      if (allocationState(lease) === ALLOCATION_STATES.REMOVED) return false;
      if (isRecoverableAllocationState(allocationState(lease))) return true;
      const expiresAt = Date.parse(String(lease.expires_at || ''));
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
      return Number.isFinite(expiresAt) || active.has(String(lease.serial || '').trim());
    }),
  };
}

function acquireLease({
  leaseDir,
  serial,
  avdName,
  owner,
  ttlMs,
  activeSerials,
  cwd = process.cwd(),
}) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedSerial = String(serial || '').trim();
  if (!normalizedSerial) throw new Error('Missing serial for lease acquisition.');
  const active = new Set(activeSerials || []);
  if (!active.has(normalizedSerial)) {
    throw new Error(`Cannot lease inactive Android serial: ${normalizedSerial}`);
  }
  return withLeaseLock(leaseDir, () => {
    const pruned = pruneLeases(readLeaseStore(leaseDir), active, new Date());
    const matches = pruned.leases.filter(
      (lease) => String(lease.serial || '').trim() === normalizedSerial,
    );
    if (matches.length > 1) throw new Error(`Ambiguous Android serial ${normalizedSerial}.`);
    const existing = matches[0];
    const normalizedAvd = String(avdName || existing?.avd_name || '').trim();
    if (!normalizedAvd) throw new Error('Missing exact AVD identity for lease acquisition.');
    const ownerAllocation = findOwnedAllocation(pruned, { owner: normalizedOwner, avdName: normalizedAvd });
    if (existing && allocationState(existing) !== ALLOCATION_STATES.ACTIVE) {
      throw new Error(
        `Android serial ${normalizedSerial} has pending state ${allocationState(existing)}; reconcile it before reuse.`,
      );
    }
    if (existing && existing.owner !== normalizedOwner) {
      throw new Error(
        `Android serial ${normalizedSerial} is already leased by ${existing.owner}; use another AVD/serial.`,
      );
    }
    if (ownerAllocation && (ownerAllocation !== existing
      || allocationState(ownerAllocation) !== ALLOCATION_STATES.ACTIVE)) {
      throw new Error(
        `Owner ${normalizedOwner}/${normalizedAvd} already has allocation state ${allocationState(ownerAllocation)}.`,
      );
    }
    if (
      existing
      && String(existing.avd_name || '').trim()
      && String(existing.avd_name || '').trim() !== normalizedAvd
    ) {
      throw new Error(
        `Android serial ${normalizedSerial} is bound to AVD ${existing.avd_name}, not ${normalizedAvd}; refusing identity rewrite.`,
      );
    }
    if (ownerAllocation?.serial && String(ownerAllocation.serial).trim() !== normalizedSerial) {
      throw new Error(
        `Reserved allocation ${normalizedOwner}/${normalizedAvd} is bound to ${ownerAllocation.serial}, not ${normalizedSerial}.`,
      );
    }
    const prior = ownerAllocation || existing;
    const createdAt = prior?.created_at || new Date().toISOString();
    const lease = {
      ...(prior || {}),
      serial: normalizedSerial,
      console_port: serialToConsolePort(normalizedSerial),
      adb_port: serialToConsolePort(normalizedSerial) ? serialToConsolePort(normalizedSerial) + 1 : 0,
      avd_name: normalizedAvd || String(prior?.avd_name || '').trim(),
      owner: normalizedOwner,
      allocation_state: ALLOCATION_STATES.ACTIVE,
      owned_process_identities: prior?.owned_process_identities || [],
      cwd,
      pid: process.pid,
      created_at: createdAt,
      updated_at: new Date().toISOString(),
      heartbeat_at: new Date().toISOString(),
      expires_at: new Date(Date.now() + (ttlMs || DEFAULT_LEASE_TTL_MS)).toISOString(),
    };
    delete lease.allocation_error;
    const next = {
      version: 1,
      leases: [
        ...pruned.leases.filter((item) => item !== ownerAllocation && item !== existing),
        lease,
      ].sort((a, b) => String(a.serial).localeCompare(String(b.serial))),
    };
    writeLeaseStore(leaseDir, next);
    return lease;
  });
}

function heartbeatLease({ leaseDir, serial, owner, ttlMs, activeSerials, now = new Date() }) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedSerial = String(serial || '').trim();
  if (!normalizedSerial) throw new Error('Missing serial for lease heartbeat.');
  const active = new Set(activeSerials || []);
  if (!active.has(normalizedSerial)) {
    throw new Error(`Cannot heartbeat inactive Android serial: ${normalizedSerial}`);
  }
  return withLeaseLock(leaseDir, () => {
    const store = readLeaseStore(leaseDir);
    const matches = store.leases.filter((lease) => String(lease?.serial || '').trim() === normalizedSerial);
    if (matches.length > 1) throw new Error(`Ambiguous Android serial ${normalizedSerial}.`);
    const existing = matches[0];
    if (!existing) {
      throw new Error(`Cannot heartbeat ${normalizedSerial}; no Android emulator lease exists.`);
    }
    if (existing.owner !== normalizedOwner) {
      throw new Error(
        `Refusing to heartbeat ${normalizedSerial}; lease owner is ${existing.owner}, not ${normalizedOwner}.`,
      );
    }
    if (allocationState(existing) !== ALLOCATION_STATES.ACTIVE) {
      throw new Error(
        `Cannot heartbeat ${normalizedSerial}; allocation state ${allocationState(existing)} requires reconciliation.`,
      );
    }
    const heartbeatAt = now.toISOString();
    const updatedLease = {
      ...existing,
      owner: normalizedOwner,
      updated_at: heartbeatAt,
      heartbeat_at: heartbeatAt,
      expires_at: new Date(now.getTime() + (ttlMs || DEFAULT_LEASE_TTL_MS)).toISOString(),
    };
    const nowMs = now.getTime();
    const next = {
      version: 1,
      leases: [
        ...((store.leases || []).filter((lease) => {
          if (!lease || typeof lease !== 'object') return false;
          const leaseSerial = String(lease?.serial || '').trim();
          if (lease === existing) return false;
          if (isRecoverableAllocationState(allocationState(lease))) return true;
          if (!leaseSerial || leaseSerial === normalizedSerial) return false;
          const expiresAt = Date.parse(String(lease.expires_at || ''));
          if (Number.isFinite(expiresAt) && expiresAt <= nowMs) return false;
          return active.has(leaseSerial);
        })),
        updatedLease,
      ].sort((a, b) => String(a.serial).localeCompare(String(b.serial))),
    };
    writeLeaseStore(leaseDir, next);
    return updatedLease;
  });
}

function assertLeaseIdentity(lease, { avdName, owner, serial }) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedSerial = String(serial || '').trim();
  const normalizedAvd = String(avdName || '').trim();
  if (!normalizedSerial || !normalizedAvd) {
    throw new Error('Exact Android serial and AVD name are required.');
  }
  if (!lease) {
    throw new Error(`No durable Android emulator lease exists for ${normalizedSerial}.`);
  }
  if (String(lease.serial || '').trim() !== normalizedSerial) {
    throw new Error(`Android lease serial does not match ${normalizedSerial}.`);
  }
  if (String(lease.owner || '').trim() !== normalizedOwner) {
    throw new Error(
      `Refusing Android lease operation for ${normalizedSerial}; lease owner is ${lease.owner || '<missing>'}, not ${normalizedOwner}.`,
    );
  }
  if (String(lease.avd_name || '').trim() !== normalizedAvd) {
    throw new Error(
      `Refusing Android lease operation for ${normalizedSerial}; lease AVD is ${lease.avd_name || '<missing>'}, not ${normalizedAvd}.`,
    );
  }
  return lease;
}

function assertAllocationIdentity(payload, { avdName, owner }) {
  const allocation = payload && typeof payload === 'object' ? payload : {};
  const serial = String(allocation.serial || '').trim();
  const lease = allocation.lease && typeof allocation.lease === 'object' ? allocation.lease : null;
  assertLeaseIdentity(lease, { avdName, owner, serial });
  const expiresAt = Date.parse(String(lease.expires_at || ''));
  if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
    throw new Error('Allocator returned expired or malformed lease expiry.');
  }
  if (allocationState(lease) !== ALLOCATION_STATES.ACTIVE) {
    throw new Error(
      `Allocator returned non-active allocation state ${allocationState(lease)} for ${serial || '<missing>'}.`,
    );
  }
  if (String(lease.serial || '').trim() !== serial) {
    throw new Error(
      `Allocator serial mismatch: result=${serial || '<missing>'} lease=${lease.serial || '<missing>'}.`,
    );
  }
  if (String(allocation.avd_name || '').trim() !== String(avdName || '').trim()) {
    throw new Error(
      `Allocator AVD mismatch: result=${allocation.avd_name || '<missing>'} requested=${avdName || '<missing>'}.`,
    );
  }
  return {
    avd_name: String(allocation.avd_name || '').trim(),
    lease,
    owner: String(lease.owner || '').trim(),
    serial,
    status: String(allocation.status || '').trim(),
  };
}

function releaseLease({ leaseDir, serial, owner, activeSerials, force = false }) {
  const normalizedOwner = sanitizeOwner(owner);
  const normalizedSerial = String(serial || '').trim();
  return withLeaseLock(leaseDir, () => {
    const pruned = pruneLeases(readLeaseStore(leaseDir), activeSerials || [], new Date());
    const matches = pruned.leases.filter((lease) => lease.serial === normalizedSerial);
    if (matches.length > 1) throw new Error(`Ambiguous Android serial ${normalizedSerial}.`);
    const existing = matches[0];
    if (!existing) {
      return { released: false, reason: 'lease_not_found' };
    }
    if (!force && existing.owner !== normalizedOwner) {
      throw new Error(
        `Refusing to release ${normalizedSerial}; lease owner is ${existing.owner}, not ${normalizedOwner}.`,
      );
    }
    if (allocationState(existing) !== ALLOCATION_STATES.ACTIVE) {
      throw new Error('Pending Android allocation requires reconciliation before release.');
    }
    const next = {
      version: 1,
      leases: pruned.leases.filter((lease) => lease.serial !== normalizedSerial),
    };
    writeLeaseStore(leaseDir, next);
    return { released: true, lease: existing };
  });
}

function countAndroidCapacityOccupancy(devices = [], leases = []) {
  const occupied = new Set(devices.filter((device) => device?.status === 'device'
    && (device.isEmulator || /^emulator-\d+$/.test(String(device.serial || ''))))
    .map((device) => String(device.serial || '').trim()).filter(Boolean));
  let serialLess = 0;
  for (const lease of leases) {
    if (!lease || typeof lease !== 'object') continue;
    if (!isRecoverableAllocationState(allocationState(lease))) continue;
    const serial = String(lease?.serial || '').trim();
    if (serial) occupied.add(serial);
    else serialLess += 1;
  }
  return occupied.size + serialLess;
}

module.exports = {
  ALLOCATION_STATES, AndroidLeaseStoreReadError, DEFAULT_LEASE_TTL_MS, countAndroidCapacityOccupancy,
  serialToConsolePort, sanitizeOwner, leaseStorePath, readLeaseStore, writeLeaseStore, withLeaseLock, allocationState, isRecoverableAllocationState, findOwnedAllocation, reserveAllocation, transitionOwnedAllocation, closeOwnedAllocation, pruneLeases, acquireLease, heartbeatLease, assertLeaseIdentity, assertAllocationIdentity, releaseLease,
};
