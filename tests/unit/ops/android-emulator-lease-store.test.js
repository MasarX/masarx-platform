const fs = require('fs');
const os = require('os');
const path = require('path');
const store = require('../../../scripts/ops/android-emulator-lease-store');

const S = store.ALLOCATION_STATES;
const owner = 'ci:run:1';
const avdName = 'MasarX_Test';
const serial = 'emulator-5556';
const processIdentity = (options = {}) => ({ pid: 41, parent_pid: 1,
  creation_date: 'synthetic-birth', executable_path: '/synthetic/emulator',
  command_line: 'emulator -avd MasarX_Test', avd_name: avdName, ...options });
let leaseDir;
const read = () => store.readLeaseStore(leaseDir).leases;
const write = (leases) => store.writeLeaseStore(leaseDir, { version: 1, leases });
const reserve = (options = {}) => store.reserveAllocation({ leaseDir, owner, avdName, ...options });
const transition = (expected, next, options = {}) => store.transitionOwnedAllocation({
  leaseDir, owner, avdName, expectedStates: [expected], nextState: next, ...options,
});
const acquire = (options = {}) => store.acquireLease({
  leaseDir, owner, avdName, serial, activeSerials: [serial], ...options,
});
const legacy = (options = {}) => ({
  owner, avd_name: avdName, serial, expires_at: '2999-01-01T00:00:00Z',
  created_at: '2026-01-01T00:00:00Z', ...options,
});

beforeEach(() => { leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'masarx-android-store-')); });
afterEach(() => { fs.rmSync(leaseDir, { recursive: true, force: true }); });

test('missing store reads are pure; malformed existing stores fail closed', () => {
  expect(store.readLeaseStore(leaseDir)).toEqual({ version: 1, leases: [] });
  expect(fs.readdirSync(leaseDir)).toEqual([]);
  for (const text of ['broken', 'null', '[]', '{"leases":{}}']) {
    fs.writeFileSync(store.leaseStorePath(leaseDir), text);
    expect(() => store.readLeaseStore(leaseDir)).toThrow(store.AndroidLeaseStoreReadError);
    expect(fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8')).toBe(text);
  }
});

test('legacy store without a version remains readable without rewriting it', () => {
  const text = JSON.stringify({ leases: [legacy()] });
  fs.writeFileSync(store.leaseStorePath(leaseDir), text);
  expect(store.readLeaseStore(leaseDir)).toEqual({ version: 1, leases: [legacy()] });
  expect(fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8')).toBe(text);
});

test.each([
  { version: 2, leases: [] },
  { version: '1', leases: [] },
  { version: null, leases: [] },
  { version: 1, leases: [legacy({ serial: '', allocation_state: 'future-reserved' })] },
  { version: 1, leases: [legacy({ allocation_state: 0 })] },
  { version: 1, leases: [legacy({ allocation_state: false })] },
])('unsupported store version/state fails closed without changing the file: %j', (payload) => {
  const text = JSON.stringify(payload);
  fs.writeFileSync(store.leaseStorePath(leaseDir), text);
  expect(() => store.readLeaseStore(leaseDir)).toThrow(store.AndroidLeaseStoreReadError);
  expect(() => reserve()).toThrow(store.AndroidLeaseStoreReadError);
  expect(fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8')).toBe(text);
  expect(fs.readdirSync(leaseDir)).toEqual(['leases.json']);
});

test('legacy active acquisition, heartbeat and release preserve their API', () => {
  write([legacy()]);
  expect(store.allocationState(read()[0])).toBe(S.ACTIVE);
  const acquired = acquire();
  expect(acquired).toMatchObject({ serial, owner, avd_name: avdName, console_port: 5556,
    adb_port: 5557, created_at: '2026-01-01T00:00:00Z', allocation_state: S.ACTIVE });
  expect(acquire({ avdName: undefined }).avd_name).toBe(avdName);
  const now = new Date('2998-10-24T12:00:00Z');
  expect(store.heartbeatLease({ leaseDir, owner, serial, activeSerials: [serial], now, ttlMs: 1000 }))
    .toMatchObject({ heartbeat_at: now.toISOString(), expires_at: '2998-10-24T12:00:01.000Z' });
  expect(store.releaseLease({ leaseDir, owner, serial, activeSerials: [serial] }))
    .toMatchObject({ released: true, lease: { serial } });
  expect(read()).toEqual([]);
});

test('pre-spawn reservation persists immutable identity and rejects owner or AVD collisions', () => {
  const reserved = reserve({ beforeSerials: ['emulator-5554'], beforeProcessIds: [41] });
  expect(read()).toEqual([reserved]);
  expect(reserved).toMatchObject({ allocation_state: S.RESERVED, owner, avd_name: avdName,
    serial: '', before_serials: ['emulator-5554'], before_process_ids: [41] });
  expect(reserved.allocation_generation).toMatch(/^[0-9a-f-]{36}$/);
  expect(() => reserve({ owner: 'foreign' })).toThrow('already exists');
  expect(() => reserve({ avdName: 'DifferentAvd' })).toThrow('already exists');
  expect(read()).toEqual([reserved]);
});

test.each([{}, { activeSerials: [] }])('reservation preserves foreign active leases without liveness authority: %j', (options) => {
  const foreign = legacy({ owner: 'foreign', avd_name: 'OtherAvd', expires_at: '2000-01-01T00:00:00Z' });
  const removed = legacy({ owner: 'removed', avd_name: 'RemovedAvd', allocation_state: S.REMOVED });
  write([foreign, removed]);
  const reserved = reserve(options);
  expect(read()).toEqual(expect.arrayContaining([foreign, reserved]));
  expect(read()).toHaveLength(2);
});

test('foreign active AVD collision is preserved even when the liveness list is omitted', () => {
  const foreign = legacy({ owner: 'foreign' });
  write([foreign]);
  expect(() => reserve()).toThrow('already exists');
  expect(read()).toEqual([foreign]);
});

test('explicit startup and failure transitions retain generation and reject missing active serial', () => {
  const reserved = reserve();
  transition(S.RESERVED, S.STARTING, { updates: { launch_pid: 41 } });
  expect(() => transition(S.STARTING, S.STARTING, { updates: { launch_pid: 42 } }))
    .toThrow('launch PID');
  expect(() => transition(S.STARTING, S.ACTIVE)).toThrow('exact serial');
  const identities = [processIdentity()];
  const active = transition(S.STARTING, S.ACTIVE, { serial,
    updates: { owned_process_identities: identities } });
  expect(active).toMatchObject({ allocation_generation: reserved.allocation_generation, serial,
    owned_process_identities: identities, launch_pid: 41 });
  expect(acquire()).toMatchObject({ allocation_generation: reserved.allocation_generation,
    owned_process_identities: identities });
  transition(S.ACTIVE, S.STOP_REQUESTED);
  transition(S.STOP_REQUESTED, S.STOP_FAILED, { error: 'synthetic stop failure' });
  expect(read()[0]).toMatchObject({ allocation_state: S.STOP_FAILED,
    allocation_error: 'synthetic stop failure' });
  transition(S.STOP_FAILED, S.STOP_REQUESTED);
  expect(read()[0]).not.toHaveProperty('allocation_error');
});

test('startup failure goes through stop_requested; invalid transitions do not write', () => {
  reserve();
  expect(() => transition(S.RESERVED, S.ACTIVE, { serial })).toThrow('Disallowed');
  transition(S.RESERVED, S.STARTING);
  const before = read();
  expect(() => transition(S.STARTING, S.STOP_FAILED)).toThrow('Disallowed');
  expect(() => transition(S.RESERVED, S.STARTING)).toThrow('Invalid');
  expect(read()).toEqual(before);
  transition(S.STARTING, S.STOP_REQUESTED);
  transition(S.STOP_REQUESTED, S.STOP_FAILED);
  expect(read()[0].allocation_state).toBe(S.STOP_FAILED);
});

test('activation requires complete nonempty lineage; rejected writes preserve the file', () => {
  reserve();
  transition(S.RESERVED, S.STARTING, { serial });
  const before = fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8');
  for (const lineage of [undefined, [], null, [processIdentity({ pid: 0 })],
    [processIdentity({ parent_pid: -1 })], [processIdentity({ creation_date: '' })],
    [processIdentity({ executable_path: '' })], [processIdentity({ command_line: '' })],
    [processIdentity({ avd_name: 'Other' })], [processIdentity(), processIdentity()]]) {
    expect(() => transition(S.STARTING, S.ACTIVE, { updates: lineage === undefined
      ? {} : { owned_process_identities: lineage } })).toThrow();
    expect(fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8')).toBe(before);
  }
});

test('recorded lineage cannot be cleared, replaced or PID-reused; descendants append', () => {
  reserve();
  transition(S.RESERVED, S.STARTING, { updates: { owned_process_identities: [processIdentity()] } });
  const before = fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8');
  for (const lineage of [[], [processIdentity({ pid: 42 })],
    [processIdentity({ creation_date: 'reused-birth' })],
    [processIdentity({ executable_path: '/other/emulator' })],
    [processIdentity({ command_line: 'emulator -avd MasarX_Test -other' })]]) {
    expect(() => transition(S.STARTING, S.STARTING,
      { updates: { owned_process_identities: lineage } })).toThrow('remove or replace');
    expect(fs.readFileSync(store.leaseStorePath(leaseDir), 'utf8')).toBe(before);
  }
  const lineage = [processIdentity(), processIdentity({ pid: 42, parent_pid: 41 })];
  const appended = transition(S.STARTING, S.STARTING, { updates: { owned_process_identities: lineage } });
  expect(appended.owned_process_identities).toEqual(lineage);
  expect(transition(S.STARTING, S.ACTIVE, { serial }).owned_process_identities).toEqual(lineage);
});

test('reacquire cannot override recorded lineage, allocation identity or state with extra arguments', () => {
  const lineage = [processIdentity()];
  reserve();
  transition(S.RESERVED, S.STARTING, { updates: { owned_process_identities: lineage } });
  const active = transition(S.STARTING, S.ACTIVE, { serial });
  const reacquired = acquire({ ownedProcessIdentities: [processIdentity({ creation_date: 'reused' })],
    owned_process_identities: [], allocation_generation: 'replacement',
    allocation_state: S.RESERVED, updates: { owner: 'foreign' } });
  expect(reacquired).toMatchObject({ owned_process_identities: lineage,
    allocation_generation: active.allocation_generation, allocation_state: S.ACTIVE, owner });
  expect(read()[0].owned_process_identities).toEqual(lineage);
});

test.each([{ owner, serial }, { owner, avdName }, { owner, avdName, serial: '' },
  { owner, avdName: '', serial }])('lease identity rejects incomplete expected identity: %j', (expected) => {
  expect(() => store.assertLeaseIdentity(legacy(), expected)).toThrow('Exact Android serial and AVD');
});

test.each(['owner', 'avd_name', 'allocation_generation', 'serial', 'allocation_state',
  'expires_at', 'before_process_ids', 'cwd'])('transition rejects patch overwrite of %s', (field) => {
  reserve();
  const before = read();
  expect(() => transition(S.RESERVED, S.STARTING, { updates: { [field]: 'overwritten' } }))
    .toThrow('protected');
  expect(read()).toEqual(before);
});

test('serial binding cannot overwrite an existing serial or collide with another allocation', () => {
  reserve();
  transition(S.RESERVED, S.STARTING, { serial });
  expect(() => transition(S.STARTING, S.ACTIVE, { serial: 'emulator-5558' }))
    .toThrow('Refusing to change');
  write([...read(), legacy({ owner: 'foreign', avd_name: 'Other', serial: 'emulator-5560' })]);
  expect(() => transition(S.STARTING, S.STARTING, { serial: 'emulator-5560' })).toThrow();
  write([legacy({ owner: 'foreign', avd_name: 'Other' }), { ...read()[0], serial: '' }]);
  expect(() => transition(S.STARTING, S.ACTIVE, { serial })).toThrow('another allocation');
});

test.each([S.RESERVED, S.STARTING, S.STOP_REQUESTED, S.STOP_FAILED])(
  'heartbeat B and pruning retain serial-less expired %s allocation A', (allocation_state) => {
    const pending = legacy({ serial: '', owner: 'pending-owner', avd_name: 'Pending',
      allocation_state, expires_at: '2000-01-01T00:00:00Z' });
    write([pending, legacy()]);
    expect(store.pruneLeases(store.readLeaseStore(leaseDir), [], new Date()).leases)
      .toContainEqual(pending);
    store.heartbeatLease({ leaseDir, owner, serial, activeSerials: [serial] });
    expect(read()).toContainEqual(pending);
  },
);

test.each([S.RESERVED, S.STARTING, S.STOP_REQUESTED, S.STOP_FAILED])(
  '%s allocation cannot be silently reacquired, heartbeated or released', (allocation_state) => {
    write([legacy({ allocation_state })]);
    const before = read();
    expect(() => acquire()).toThrow('pending state');
    expect(() => store.heartbeatLease({ leaseDir, owner, serial, activeSerials: [serial] }))
      .toThrow('requires reconciliation');
    expect(() => store.releaseLease({ leaseDir, owner, serial, activeSerials: [serial], force: true }))
      .toThrow('requires reconciliation');
    expect(read()).toEqual(before);
  },
);

test('a serial-less reservation cannot be activated implicitly by ordinary acquire', () => {
  reserve();
  expect(() => acquire()).toThrow('already has allocation state reserved');
  expect(read()[0].serial).toBe('');
});

test('acquisition and heartbeat reject foreign ownership and ambiguous records', () => {
  write([legacy({ owner: 'foreign' })]);
  expect(() => acquire()).toThrow('already leased');
  expect(() => store.heartbeatLease({ leaseDir, owner, serial, activeSerials: [serial] }))
    .toThrow('lease owner');
  write([legacy(), legacy()]);
  expect(() => acquire()).toThrow('Ambiguous');
  expect(() => store.heartbeatLease({ leaseDir, owner, serial, activeSerials: [serial] }))
    .toThrow('Ambiguous');
  expect(() => store.releaseLease({ leaseDir, owner, serial, activeSerials: [serial] }))
    .toThrow('Ambiguous');
  expect(() => store.findOwnedAllocation(store.readLeaseStore(leaseDir), { owner, avdName }))
    .toThrow('Ambiguous');
  write([legacy(), legacy({ serial: 'emulator-5558' })]);
  expect(() => store.findOwnedAllocation(store.readLeaseStore(leaseDir), { owner, avdName, serial }))
    .toThrow('Ambiguous');
  write([legacy()]);
  expect(() => acquire({ avdName: 'Other' })).toThrow('refusing identity rewrite');
});

test('legacy active pruning preserves unexpired ownership during temporary ADB loss', () => {
  const alive = legacy();
  write([alive, legacy({ serial: 'emulator-5558', expires_at: '2000-01-01T00:00:00Z' })]);
  expect(store.pruneLeases(store.readLeaseStore(leaseDir), [], new Date()).leases).toEqual([alive]);
  expect(store.pruneLeases(store.readLeaseStore(leaseDir), [serial, 'emulator-5558'], new Date()).leases)
    .toEqual([alive]);
});

test('closing requires stop_requested and exact owner, AVD and bound serial', () => {
  reserve();
  expect(() => store.closeOwnedAllocation({ leaseDir, owner, avdName })).toThrow('stop_requested');
  transition(S.RESERVED, S.STARTING, { serial });
  transition(S.STARTING, S.STOP_REQUESTED);
  for (const wrong of [{ owner: 'foreign' }, { avdName: 'Other' }, { serial: 'emulator-5558' }, { serial: '' }]) {
    expect(() => store.closeOwnedAllocation({ leaseDir, owner, avdName, serial, ...wrong })).toThrow();
  }
  const closed = store.closeOwnedAllocation({ leaseDir, owner, avdName, serial });
  expect(closed).toMatchObject({ allocation_state: S.REMOVED, serial });
  expect(read()).toEqual([]);
});

test('pre-spawn cancellation closes a reserved record only after stop_requested', () => {
  reserve();
  transition(S.RESERVED, S.STOP_REQUESTED);
  expect(store.closeOwnedAllocation({ leaseDir, owner, avdName }).allocation_state).toBe(S.REMOVED);
  expect(read()).toEqual([]);
});

test('legacy interrupted releases retain recoverable ownership instead of looking active', () => {
  for (const release_state of ['stop_requested', 'stop_failed']) {
    write([legacy({ release_state, expires_at: '2000-01-01T00:00:00Z' })]);
    expect(store.allocationState(read()[0])).toBe(release_state);
    expect(store.pruneLeases(store.readLeaseStore(leaseDir), [], new Date()).leases).toHaveLength(1);
    expect(() => acquire()).toThrow('pending state');
  }
});

test('allocation output validation requires active matching owner, AVD and serial', () => {
  const payload = { serial, avd_name: avdName, lease: legacy() };
  expect(store.assertAllocationIdentity(payload, { owner, avdName })).toMatchObject({ owner, serial });
  for (const lease of [legacy({ owner: 'foreign' }), legacy({ avd_name: 'Other' }),
    legacy({ serial: 'emulator-5558' }), legacy({ allocation_state: S.STOP_FAILED })]) {
    expect(() => store.assertAllocationIdentity({ ...payload, lease }, { owner, avdName })).toThrow();
  }
});

test.each(['2000-01-01T00:00:00Z', 'invalid-expiry'])(
  'publication rejects expiry %s while cleanup identity remains usable', (expires_at) => {
    const lease = legacy({ expires_at });
    expect(store.assertLeaseIdentity(lease, { owner, avdName, serial })).toBe(lease);
    expect(() => store.assertAllocationIdentity({ serial, avd_name: avdName, lease }, { owner, avdName }))
      .toThrow('expired or malformed');
  },
);

test('capacity counts unique live emulator serials and every pending serial-less allocation', () => {
  const devices = [{ serial, status: 'device', isEmulator: true },
    { serial, status: 'device', isEmulator: true },
    { serial: 'physical-device', status: 'device', isEmulator: false },
    { serial: 'emulator-5558', status: 'offline', isEmulator: true }];
  const leases = [legacy({ allocation_state: S.STARTING }),
    ...[S.RESERVED, S.STARTING, S.STOP_REQUESTED, S.STOP_FAILED].map((allocation_state) => (
      legacy({ serial: '', allocation_state, expires_at: '2000-01-01T00:00:00Z' })
    )), legacy({ serial: 'emulator-5560', allocation_state: S.STOP_FAILED }),
    legacy({ serial: 'emulator-5560', allocation_state: S.STOP_REQUESTED }),
    legacy({ serial: 'emulator-5562', allocation_state: S.REMOVED })];
  expect(store.countAndroidCapacityOccupancy(devices, leases)).toBe(6);
  expect(store.countAndroidCapacityOccupancy()).toBe(0);
});
