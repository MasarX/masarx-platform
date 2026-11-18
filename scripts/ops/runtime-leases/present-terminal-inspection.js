'use strict';
// Proposed scripts/ops/runtime-leases/present-terminal-inspection.js.
// Scoped observation only: the caller must separately exclude new dispatch and
// verify Docker, listeners, ownership locks and the exact allocation receipt.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');

function check(value, message) { if (!value) throw new Error(message); }
function withinPath(value, root) {
  return value === root || value.startsWith(root === '/' ? '/' : root + '/');
}
function admitControllerParent(controller, expected, observed, controls) {
  if (!expected) return null;
  check(controller.ppid === expected.pid && sameIdentity(observed, expected),
    'present_terminal_controller_parent_changed');
  controls.add(expected.pid);
  return expected;
}
function assertControllerParentUnchanged(expected, observed) {
  if (expected) check(sameIdentity(observed, expected),
    'present_terminal_controller_parent_changed_after_scan');
}
function processBlocksTerminality(row, controls, admittedReaders) {
  return controls.has(row.pid) ? row.handles.some(fd => fd.writable) : !admittedReaders.has(row.pid);
}
function validateRetainedVolumeStructure(volumes, projectId) {
  check(Array.isArray(volumes) && volumes.length === 3 &&
    /^[A-Za-z0-9_-]{3,128}$/.test(String(projectId || '')), 'present_terminal_volumes_invalid');
  const expected = ['db', 'edge_runtime', 'storage'].map(part => 'supabase_' + part + '_' + projectId).sort();
  check(JSON.stringify(volumes.map(row => row?.name).sort()) === JSON.stringify(expected),
    'present_terminal_volumes_invalid');
  const validated = volumes.map(row => {
    const mountpoint = row?.mountpoint;
    check(typeof mountpoint === 'string' && path.posix.isAbsolute(mountpoint) &&
      mountpoint !== '/' && path.posix.normalize(mountpoint) === mountpoint &&
      path.posix.basename(mountpoint) === '_data' &&
      path.posix.basename(path.posix.dirname(mountpoint)) === row.name &&
      path.posix.basename(path.posix.dirname(path.posix.dirname(mountpoint))) === 'volumes' &&
      /^[a-f0-9]{64}$/.test(String(row.fingerprint || '')),
      'present_terminal_volume_mountpoint_invalid');
    return { name: row.name, mountpoint, fingerprint: row.fingerprint };
  });
  check(new Set(validated.map(row => path.posix.dirname(path.posix.dirname(row.mountpoint)))).size === 1,
    'present_terminal_volume_data_root_mismatch');
  return validated.sort((a, b) => a.name.localeCompare(b.name));
}
function validateRetainedVolumes(volumes, projectId, files = fs) {
  const validated = validateRetainedVolumeStructure(volumes, projectId);
  for (const volume of validated) {
    check(files.realpathSync(volume.mountpoint) === volume.mountpoint &&
      files.statSync(volume.mountpoint).isDirectory(), 'present_terminal_volume_mountpoint_invalid');
  }
  return validated;
}
function parseMountinfo(raw) {
  check(typeof raw === 'string' && raw.length > 0 && raw.length <= 4 * 1024 * 1024,
    'present_terminal_mountinfo_invalid');
  const decode = value => value.replace(/\\([0-7]{3})/g, (_, digits) =>
    String.fromCharCode(parseInt(digits, 8)));
  return raw.trimEnd().split('\n').map(line => {
    const halves = line.split(' - '), fields = halves[0]?.split(' ');
    check(halves.length === 2 && fields.length >= 6 && /^\d+:\d+$/.test(fields[2]) &&
      fields[3].startsWith('/') && fields[4].startsWith('/'), 'present_terminal_mountinfo_invalid');
    return { device: fields[2], root: decode(fields[3]), mountpoint: decode(fields[4]) };
  });
}
function assertRetainedVolumeMounts(hostRaw, processRaw, volumes) {
  const host = parseMountinfo(hostRaw), observed = parseMountinfo(processRaw);
  for (const volume of volumes) {
    const base = host.filter(entry => withinPath(volume.mountpoint, entry.mountpoint))
      .sort((a, b) => b.mountpoint.length - a.mountpoint.length)[0];
    check(base, 'present_terminal_volume_mount_authority_missing');
    check(base.mountpoint !== volume.mountpoint, 'present_terminal_volume_mount_alias_present');
    const onFilesystem = path.posix.join(base.root, path.posix.relative(base.mountpoint, volume.mountpoint));
    const sameBase = entry => entry.device === base.device && entry.root === base.root &&
      entry.mountpoint === base.mountpoint;
    check(observed.some(sameBase), 'present_terminal_volume_mount_namespace_unknown');
    for (const entry of observed) {
      if ((entry.device === base.device && withinPath(onFilesystem, entry.root) && !sameBase(entry)) ||
        (withinPath(entry.mountpoint, volume.mountpoint) && !sameBase(entry))) {
        throw new Error('present_terminal_volume_mount_alias_present');
      }
    }
  }
}
function validateSuccessorPorts(ports) {
  check(Array.isArray(ports) && ports.length > 0 && ports.length <= 16 &&
    ports.every(port => Number.isSafeInteger(port) && port > 0 && port <= 65535) &&
    new Set(ports).size === ports.length, 'present_terminal_successor_ports_invalid');
  return [...ports].sort((a, b) => a - b);
}
function assertSuccessorPortsUnbound(ports, files = fs) {
  const expected = new Set(validateSuccessorPorts(ports));
  for (const protocol of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const raw = files.readFileSync('/proc/net/' + protocol, 'utf8');
    check(typeof raw === 'string' && raw.length <= 4 * 1024 * 1024,
      'present_terminal_successor_socket_table_invalid');
    const lines = raw.trim().split('\n');
    check(/local_address/.test(lines.shift() || ''), 'present_terminal_successor_socket_table_invalid');
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      check(fields.length >= 10 && /^\d+:$/.test(fields[0]) &&
        /^[A-F0-9]+:[A-F0-9]{4}$/.test(fields[1]), 'present_terminal_successor_socket_table_invalid');
      if (expected.has(parseInt(fields[1].slice(-4), 16))) {
        throw new Error('present_terminal_successor_port_bound');
      }
    }
  }
}
function vanishedProcEntry(file, files = fs) {
  try { files.lstatSync(file); return false; }
  catch (error) { if (['ENOENT', 'ESRCH'].includes(error.code)) return true; throw error; }
}
function identity(pid) {
  const raw = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
  const fields = raw.slice(raw.lastIndexOf(')') + 1).trim().split(/\s+/);
  const exe = fs.statSync(`/proc/${pid}/exe`);
  return { pid: Number(pid), ppid: Number(fields[1]), birth: fields[19],
    exe: { dev: exe.dev, ino: exe.ino } };
}
function sameIdentity(a, b) {
  return a.pid === b.pid && a.ppid === b.ppid && a.birth === b.birth &&
    a.exe.dev === b.exe.dev && a.exe.ino === b.exe.ino;
}
function exactReader(actual, expected, rows) {
  return Boolean(actual && expected &&
    ['pid', 'ppid', 'birth', 'comm', 'uid', 'cwd', 'argvSHA'].every(k => actual[k] === expected[k]) &&
    actual.exe.dev === expected.exe.dev && actual.exe.ino === expected.exe.ino &&
    JSON.stringify(actual.fds) === JSON.stringify(expected.fds) && actual.children === '' &&
    !rows.some(row => row.ppid === expected.pid ||
      (row.pid === expected.pid && row.handles.some(fd => fd.writable))));
}

function registrationSymlinkTarget(file, before, relevantTokens, files = fs) {
  try { return files.realpathSync(file); }
  catch (error) {
    // User-systemd invocation links contain an invocation ID, not a unit-file
    // path. Admit only unchanged, unrelated bookkeeping of this exact shape.
    if (error.code !== 'ENOENT') throw error;
    const match = file.match(/^\/run\/user\/(\d+)\/systemd\/units\/invocation:([A-Za-z0-9_.@:-]+)$/);
    if (!match || /^masarx-/i.test(match[2]) || relevantTokens.some(token => file.includes(token))) throw error;
    const target = files.readlinkSync(file);
    if (!/^[a-f0-9]{32}$/.test(target)) throw error;
    const after = files.lstatSync(file);
    if (!before.isSymbolicLink() || !after.isSymbolicLink() || before.uid !== Number(match[1]) ||
        after.uid !== before.uid || after.dev !== before.dev || after.ino !== before.ino ||
        files.readlinkSync(file) !== target) throw error;
    return null;
  }
}

function terminalTransientUnit(file, input, io = {}) {
  const files = io.fsImpl || fs, run = io.spawnSyncImpl || spawnSync;
  const uid = input.controllerUid;
  const root = `/run/user/${uid}/systemd/transient/`;
  const unit = path.basename(file);
  check(Number.isSafeInteger(uid) && uid > 0 && file === root + unit &&
    /^masarx-[A-Za-z0-9_.@-]+\.service$/.test(unit), 'present_terminal_unit_scope_unknown');
  check(files.realpathSync(file) === file, 'present_terminal_unit_path_aliased');
  function definition() {
    const before = files.lstatSync(file);
    check(before.isFile() && !before.isSymbolicLink() && before.uid === uid &&
      (before.mode & 0o022) === 0 && before.size <= 1024 * 1024, 'present_terminal_unit_owner_unknown');
    const fd = files.openSync(file, files.constants.O_RDONLY | files.constants.O_NOFOLLOW);
    try {
      const opened = files.fstatSync(fd);
      check(opened.dev === before.dev && opened.ino === before.ino, 'present_terminal_unit_replaced');
      const bytes = files.readFileSync(fd), after = files.fstatSync(fd);
      check(after.size === before.size && after.mtimeMs === before.mtimeMs &&
        bytes.length === before.size && bytes.toString('utf8').includes(input.cwd), 'present_terminal_unit_definition_unbound');
      return { dev: after.dev, ino: after.ino, uid, size: after.size, mtimeMs: after.mtimeMs,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    } finally { files.closeSync(fd); }
  }
  const properties = ['Id', 'LoadState', 'ActiveState', 'SubState', 'MainPID', 'ControlPID',
    'Restart', 'Triggers', 'TriggeredBy', 'Job', 'Transient', 'FragmentPath', 'NeedDaemonReload'];
  function state() {
    const result = run('/usr/bin/sudo', ['-n', '-u', `#${uid}`, '--', '/usr/bin/env',
      `XDG_RUNTIME_DIR=/run/user/${uid}`, `DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/${uid}/bus`,
      '/usr/bin/systemctl', '--user', 'show', '--no-pager', `--property=${properties.join(',')}`, '--', unit],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 65536,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
    check(!result.error && result.status === 0 && !result.signal && !String(result.stderr || '').trim(),
      'present_terminal_unit_state_unavailable');
    const values = {};
    for (const line of String(result.stdout || '').trimEnd().split('\n')) {
      const separator = line.indexOf('=');
      const key = line.slice(0, separator);
      check(separator > 0 && properties.includes(key) && !Object.hasOwn(values, key), 'present_terminal_unit_state_invalid');
      values[key] = line.slice(separator + 1);
    }
    check(properties.every(key => Object.hasOwn(values, key)), 'present_terminal_unit_state_incomplete');
    check(values.Id === unit && values.LoadState === 'loaded' && values.Transient === 'yes' &&
      values.FragmentPath === file && values.NeedDaemonReload === 'no' &&
      ((values.ActiveState === 'failed' && values.SubState === 'failed') ||
       (values.ActiveState === 'inactive' && values.SubState === 'dead')) &&
      values.MainPID === '0' && values.ControlPID === '0' && values.Restart === 'no' &&
      ['Triggers', 'TriggeredBy', 'Job'].every(key => values[key] === ''),
    'present_terminal_unit_not_terminal');
    return values;
  }
  const first = { definition: definition(), properties: state() };
  const second = { definition: definition(), properties: state() };
  check(JSON.stringify(first) === JSON.stringify(second), 'present_terminal_unit_changed');
  return { path: file, ...second, disposition: 'retained-terminal-transient-registration' };
}

// This function is serialized into the privileged diagnostic process. It reads
// only live /proc and managed registration files; no captured report is admitted.
function inspect() {
  const input = JSON.parse(fs.readFileSync(0, 'utf8'));
  check(process.getuid() === 0, 'present_terminal_privilege_required');
  const retainedVolumes = input.retainedVolumes?.length
    ? validateRetainedVolumes(input.retainedVolumes, input.projectIds[0]) : [];
  const successorPorts = input.successorPorts?.length ? validateSuccessorPorts(input.successorPorts) : [];
  check((retainedVolumes.length === 0 && successorPorts.length === 0) ||
    (retainedVolumes.length === 3 && successorPorts.length > 0 && input.requireEmptyContainers),
    'present_terminal_retained_volume_mode_invalid');
  const hostMountinfo = retainedVolumes.length ? fs.readFileSync('/proc/self/mountinfo', 'utf8') : null;
  const ownerBefore = identity(input.controller.pid);
  input.controllerUid = fs.statSync(`/proc/${input.controller.pid}`).uid;
  check(sameIdentity(ownerBefore, input.controller), 'present_terminal_controller_changed');
  const controls = new Set([process.pid, input.controller.pid]);
  const controllerParent = admitControllerParent(input.controller, input.controllerParent,
    input.controllerParent ? identity(input.controllerParent.pid) : null, controls);
  // sudo -> timeout -> node may have a sudo monitor; admit only this freshly
  // observed direct chain, never an arbitrary caller-supplied exemption PID.
  const chain = [];
  let parent = process.ppid;
  for (let depth = 0; parent !== input.controller.pid && depth < 4; depth++) {
    const record = identity(parent), exe = fs.realpathSync(`/proc/${parent}/exe`);
    check(['/usr/bin/sudo', '/usr/bin/timeout'].includes(exe), 'present_terminal_diagnostic_parent_unknown');
    check(fs.statSync(`/proc/${parent}`).uid === 0, 'present_terminal_diagnostic_parent_not_root');
    controls.add(parent); chain.push(record); parent = record.ppid;
  }
  check(parent === input.controller.pid, 'present_terminal_diagnostic_chain_unbound');
  const tokens = [input.cwd, input.owner, ...input.projectIds];
  const relevantText = value => tokens.some(token => value.includes(token));
  const within = value => withinPath(value, input.cwd);
  const inVolume = value => retainedVolumes.some(volume => withinPath(value, volume.mountpoint));
  if (successorPorts.length) assertSuccessorPortsUnbound(successorPorts);
  const unknown = [], rows = [], readers = [];
  function reader(pid, record) {
    const fds = fs.readdirSync(`/proc/${pid}/fd`).flatMap(fd => {
      try {
        const info = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8');
        const flags = info.match(/^flags:\s*([0-7]+)$/m);
        check(flags, 'present_terminal_reader_flags_unknown');
        return [{ fd: Number(fd), target: fs.readlinkSync(`/proc/${pid}/fd/${fd}`), flags: flags[1] }];
      } catch (error) {
        if (['ENOENT', 'ESRCH'].includes(error.code) && vanishedProcEntry(`/proc/${pid}/fd/${fd}`)) return [];
        throw error;
      }
    }).sort((a, b) => a.fd - b.fd);
    return { ...record, comm: fs.readFileSync(`/proc/${pid}/comm`, 'utf8').trim(),
      uid: fs.statSync(`/proc/${pid}`).uid, cwd: fs.readlinkSync(`/proc/${pid}/cwd`),
      argvSHA: crypto.createHash('sha256').update(fs.readFileSync(`/proc/${pid}/cmdline`)).digest('hex'),
      fds, children: fs.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim() };
  }
  function listenerProof() {
    assertEmptyContainers();
    return captureReviewedListeners(input.reviewedListeners, pid => {
      const before = identity(pid), record = reader(pid, before);
      check(sameIdentity(before, identity(pid)), 'present_terminal_listener_identity_changed');
      return record;
    }, fs, input.captureListeners === true);
  }
  const initialListenerEvidence = input.requireEmptyContainers ? listenerProof() : undefined;
  for (const pid of fs.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    let record;
    try {
      const rawArgs = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
      // Only proven kernel threads/zombies may lack a userspace executable.
      // Empty argv alone is not an exemption for a live userspace writer.
      if (!rawArgs) {
        const status = fs.readFileSync(`/proc/${pid}/status`, 'utf8');
        if (/^Kthread:\s*1$/m.test(status) || /^State:\s*Z\b/m.test(status)) continue;
      }
      record = identity(pid);
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`), handles = [];
      if (retainedVolumes.length) {
        const prefix = '/proc/' + pid;
        assertRetainedVolumeMounts(hostMountinfo, fs.readFileSync(prefix + '/mountinfo', 'utf8'), retainedVolumes);
        const maps = fs.readFileSync(prefix + '/maps', 'utf8');
        check(!inVolume(cwd) && !inVolume(fs.readlinkSync(prefix + '/root')) &&
          !retainedVolumes.some(volume => maps.includes(volume.mountpoint + '/')),
          'present_terminal_volume_process_reference');
      }
      for (const fd of fs.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const name = fs.readlinkSync(`/proc/${pid}/fd/${fd}`);
          check(!inVolume(name), 'present_terminal_volume_descriptor_present');
          if (!within(name)) continue;
          const flags = fs.readFileSync(`/proc/${pid}/fdinfo/${fd}`, 'utf8').match(/^flags:\s*([0-7]+)$/m);
          check(flags, 'present_terminal_flags_unknown');
          const stat = fs.statSync(`/proc/${pid}/fd/${fd}`);
          handles.push({ fd: Number(fd), dev: stat.dev, ino: stat.ino, writable: (parseInt(flags[1], 8) & 3) !== 0 });
        } catch (error) {
          // Descriptor close during enumeration cannot hide a still-open writer;
          // all other descriptor inspection failures invalidate admission.
          if (!['ENOENT', 'ESRCH'].includes(error.code) ||
            !vanishedProcEntry(`/proc/${pid}/fd/${fd}`)) throw error;
        }
      }
      check(sameIdentity(record, identity(pid)), 'present_terminal_process_identity_changed');
      rows.push({ ...record, handles, relevant: within(cwd) || relevantText(rawArgs) || handles.length > 0 ||
        input.controllerPids.includes(Number(pid)) });
      const expected = input.reviewedNonwriters.find(value => value.pid === Number(pid));
      if (expected) readers.push({ expected, before: reader(pid, record) });
    } catch (error) {
      // A departed process is terminal. An inaccessible live process is unknown.
      if (!['ENOENT', 'ESRCH'].includes(error.code) || !vanishedProcEntry(`/proc/${pid}`)) {
        unknown.push({ pid: Number(pid), reason: error.code || error.message });
      }
    }
  }
  const admittedReaders = new Set();
  for (const { expected, before } of readers) {
    const after = reader(expected.pid, identity(expected.pid));
    check(JSON.stringify(before) === JSON.stringify(after) && exactReader(after, expected, rows),
      'present_terminal_reviewed_nonwriter_changed');
    admittedReaders.add(expected.pid);
  }
  const matches = rows.filter(row => row.relevant && processBlocksTerminality(row, controls, admittedReaders));

  // Registration inspection is deliberately scoped: it detects direct bindings,
  // not arbitrary wrapper scripts or dispatch from an external host. Caller must
  // establish dispatch exclusion independently; this is not a terminality oracle.
  const roots = ['/etc/systemd/system', '/run/systemd/system', '/run/systemd/transient',
    '/usr/lib/systemd/system', '/etc/systemd/user', '/run/systemd/user',
    '/etc/crontab', '/etc/cron.d', '/etc/cron.hourly', '/etc/cron.daily',
    '/etc/cron.weekly', '/etc/cron.monthly', '/var/spool/cron', '/etc/supervisor',
    '/etc/supervisord.conf', '/etc/supervisord.d', '/run/user'];
  for (const line of fs.readFileSync('/etc/passwd', 'utf8').split('\n').filter(Boolean)) {
    const fields = line.split(':');
    check(fields.length === 7, 'present_terminal_passwd_invalid');
    if (fields[5].startsWith('/')) roots.push(path.join(fields[5], '.config/systemd/user'));
  }
  const registrations = [], terminalRegistrations = [], seen = new Set();
  let inspectedFiles = 0;
  function visit(file, depth = 0) {
    check(depth <= 12 && inspectedFiles < 10000, 'present_terminal_registration_scan_limit');
    let stat;
    try { stat = fs.lstatSync(file); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (stat.isSymbolicLink()) {
      const target = registrationSymlinkTarget(file, stat, tokens);
      if (target === null) return;
      if (target === '/dev/null') return; // systemd masked unit
      return visit(target, depth + 1);
    }
    if (seen.has(file)) return;
    seen.add(file);
    if (stat.isDirectory()) {
      // /run/user contains sockets and unrelated service runtime trees. Only
      // registered user-systemd unit directories are a registration authority.
      if (file === '/run/user') {
        for (const uid of fs.readdirSync(file).filter(x => /^\d+$/.test(x))) visit(`${file}/${uid}/systemd`, depth + 1);
      } else for (const name of fs.readdirSync(file)) visit(path.join(file, name), depth + 1);
    } else if (stat.isFile()) {
      inspectedFiles++;
      check(stat.size <= 1024 * 1024, 'present_terminal_registration_size_limit');
      if (relevantText(fs.readFileSync(file, 'utf8'))) {
        const ownedTransientRoot = `/run/user/${input.controllerUid}/systemd/transient/`;
        if (file.startsWith(ownedTransientRoot) && path.dirname(file) === ownedTransientRoot.slice(0, -1)) {
          terminalRegistrations.push(terminalTransientUnit(file, input));
        } else registrations.push(file);
      }
    }
  }
  for (const root of roots) visit(root);
  for (const retained of terminalRegistrations) {
    check(JSON.stringify(terminalTransientUnit(retained.path, input)) === JSON.stringify(retained),
      'present_terminal_unit_changed_after_scan');
  }
  assertControllerParentUnchanged(controllerParent,
    controllerParent ? identity(controllerParent.pid) : null);
  check(sameIdentity(identity(input.controller.pid), ownerBefore), 'present_terminal_controller_changed_after_scan');
  for (const record of chain) check(sameIdentity(identity(record.pid), record), 'present_terminal_diagnostic_chain_changed');
  if (retainedVolumes.length) check(fs.readFileSync('/proc/self/mountinfo', 'utf8') === hostMountinfo,
    'present_terminal_volume_mount_authority_changed');
  if (successorPorts.length) assertSuccessorPortsUnbound(successorPorts);
  check(!matches.length && !unknown.length && !registrations.length,
    'present_terminal_not_quiescent:' + JSON.stringify({
      matches: matches.map(row => ({ pid: row.pid, handles: row.handles })), unknown, registrations }));
  // Listener ownership never admits a process as a nonwriter: the unchanged
  // relevant-process and descriptor checks above still cover it and its children.
  const listenerEvidence = input.requireEmptyContainers ? listenerProof() : undefined;
  if (input.captureListeners) check(JSON.stringify(listenerEvidence) === JSON.stringify(initialListenerEvidence),
    'present_terminal_listeners_changed');
  process.stdout.write(JSON.stringify({ inspectedAt: new Date().toISOString(), processCount: rows.length,
    ...(retainedVolumes.length ? { retainedVolumes: retainedVolumes.map(row => row.name), successorPorts } : {}),
    ...(input.requireEmptyContainers ? { emptyContainers: true, reviewedListeners: listenerEvidence } : {}),
    registrationFileCount: inspectedFiles, scope: 'live-processes-and-direct-registrations-only',
    historicalSettlement: 'unproven', dispatchExclusion: 'caller-required', terminalRegistrations }));
}

function validateReviewedListeners(rows) {
  check(Array.isArray(rows) && rows.length <= 256, 'present_terminal_listeners_invalid');
  const keys = new Set();
  return rows.map(row => {
    check(row && ['tcp', 'tcp6', 'udp', 'udp6'].includes(row.protocol), 'present_terminal_listeners_invalid');
    const endpoint = row.protocol.endsWith('6') ? /^[A-F0-9]{32}:[A-F0-9]{4}$/ : /^[A-F0-9]{8}:[A-F0-9]{4}$/;
    check(endpoint.test(row.local) && endpoint.test(row.remote) &&
      /^[A-F0-9]{2}$/.test(row.state) && (row.protocol.startsWith('udp') || row.state === '0A') &&
      typeof row.inode === 'string' && /^[1-9]\d*$/.test(row.inode) &&
      Array.isArray(row.owners) && row.owners.length > 0, 'present_terminal_listeners_invalid');
    const key = `${row.protocol}:${row.inode}`;
    check(!keys.has(key), 'present_terminal_listeners_invalid'); keys.add(key);
    validateReviewedNonwriters(row.owners, { listenerOwners: true });
    const owners = row.owners.map(owner => {
      check(owner.fds.some(fd => fd.target === `socket:[${row.inode}]`), 'present_terminal_listeners_invalid');
      return { pid: owner.pid, ppid: owner.ppid, birth: owner.birth, comm: owner.comm,
        uid: owner.uid, cwd: owner.cwd, argvSHA: owner.argvSHA,
        exe: { dev: owner.exe.dev, ino: owner.exe.ino },
        fds: owner.fds.filter(fd => fd.target === `socket:[${row.inode}]`)
          .map(fd => ({ fd: fd.fd, target: fd.target, flags: fd.flags })).sort((a, b) => a.fd - b.fd) };
    }).sort((a, b) => a.pid - b.pid);
    return { protocol: row.protocol, local: row.local, remote: row.remote, state: row.state, inode: row.inode, owners };
  }).sort((a, b) => `${a.protocol}:${a.inode}`.localeCompare(`${b.protocol}:${b.inode}`));
}

function readListenerSockets(files = fs) {
  const sockets = [];
  for (const protocol of ['tcp', 'tcp6', 'udp', 'udp6']) {
    const lines = files.readFileSync(`/proc/net/${protocol}`, 'utf8').trim().split('\n');
    check(/local_address/.test(lines.shift() || ''), 'present_terminal_socket_table_invalid');
    for (const line of lines) {
      const fields = line.trim().split(/\s+/);
      check(fields.length >= 10 && /^\d+:$/.test(fields[0]) && /^[A-F0-9]{2}$/.test(fields[3]),
        'present_terminal_socket_table_invalid');
      if (protocol.startsWith('tcp') && fields[3] !== '0A') continue;
      check(/^[1-9]\d*$/.test(fields[9]), 'present_terminal_socket_inode_unknown');
      sockets.push({ protocol, local: fields[1], remote: fields[2], state: fields[3], inode: fields[9] });
    }
  }
  return sockets.sort((a, b) => `${a.protocol}:${a.inode}`.localeCompare(`${b.protocol}:${b.inode}`));
}

function assertEmptyContainers(run = spawnSync) {
  const result = run('/usr/bin/docker', ['--host', 'unix:///var/run/docker.sock', 'container', 'ls', '--all', '--quiet', '--no-trunc'],
    { encoding: 'utf8', timeout: 2000, maxBuffer: 65536,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
  check(!result.error && result.status === 0 && !result.signal && !String(result.stderr || '').trim(),
    'present_terminal_container_inventory_unavailable');
  check(String(result.stdout || '').trim() === '', 'present_terminal_containers_present');
}

function captureReviewedListeners(expected, readProcess, files = fs, captureOnly = false) {
  const sockets = readListenerSockets(files);
  const namespace = files.readlinkSync('/proc/self/ns/net');
  const owners = new Map(sockets.map(socket => [socket.inode, []]));
  for (const pid of files.readdirSync('/proc').filter(value => /^\d+$/.test(value))) {
    try {
      const status = files.readFileSync(`/proc/${pid}/status`, 'utf8');
      if (/^Kthread:\s*1$/m.test(status) || /^State:\s*Z\b/m.test(status)) continue;
      // Fail closed rather than claim a host-only socket table covers another namespace.
      check(files.readlinkSync(`/proc/${pid}/ns/net`) === namespace, 'present_terminal_network_namespace_unknown');
      const inodes = new Set();
      for (const fd of files.readdirSync(`/proc/${pid}/fd`)) {
        try {
          const match = files.readlinkSync(`/proc/${pid}/fd/${fd}`).match(/^socket:\[(\d+)\]$/);
          if (match && owners.has(match[1])) inodes.add(match[1]);
        } catch (error) {
          if (!['ENOENT', 'ESRCH'].includes(error.code) || !vanishedProcEntry(`/proc/${pid}/fd/${fd}`, files)) throw error;
        }
      }
      if (inodes.size) {
        const owner = readProcess(pid);
        check(files.readlinkSync(`/proc/${pid}/ns/net`) === namespace, 'present_terminal_network_namespace_changed');
        for (const inode of inodes) owners.get(inode).push(owner);
      }
    } catch (error) {
      if (!['ENOENT', 'ESRCH'].includes(error.code) || !vanishedProcEntry(`/proc/${pid}`, files)) throw error;
    }
  }
  check(JSON.stringify(sockets) === JSON.stringify(readListenerSockets(files)), 'present_terminal_listeners_changed');
  const actual = validateReviewedListeners(sockets.map(socket => ({ ...socket, owners: owners.get(socket.inode) })));
  if (!captureOnly) check(JSON.stringify(actual) === JSON.stringify(validateReviewedListeners(expected)),
    'present_terminal_listeners_changed');
  return actual;
}

function validateReviewedNonwriters(rows, { listenerOwners = false } = {}) {
  check(Array.isArray(rows) && rows.length <= 16, 'present_terminal_nonwriters_invalid');
  const pids = new Set();
  for (const row of rows) {
    check(row && Number.isSafeInteger(row.pid) && row.pid >= (listenerOwners ? 1 : 2) && !pids.has(row.pid) &&
      Number.isSafeInteger(row.ppid) && (row.pid === 1
        ? listenerOwners && row.ppid === 0 && row.uid === 0 : row.ppid > 0) && /^\d+$/.test(String(row.birth || '')) &&
      typeof row.birth === 'string' && typeof row.comm === 'string' && row.comm.length > 0 &&
      Number.isSafeInteger(row.uid) && row.uid >= 0 && typeof row.cwd === 'string' && path.isAbsolute(row.cwd) &&
      /^[a-f0-9]{64}$/.test(row.argvSHA || '') && row.exe &&
      Number.isSafeInteger(row.exe.dev) && row.exe.dev >= 0 && Number.isSafeInteger(row.exe.ino) && row.exe.ino > 0 &&
      Array.isArray(row.fds) && row.fds.length <= 1024, 'present_terminal_nonwriters_invalid');
    const fds = new Set();
    for (const fd of row.fds) {
      check(fd && Number.isSafeInteger(fd.fd) && fd.fd >= 0 && !fds.has(fd.fd) &&
        typeof fd.target === 'string' && fd.target.length > 0 &&
        typeof fd.flags === 'string' && /^[0-7]+$/.test(fd.flags), 'present_terminal_nonwriters_invalid');
      fds.add(fd.fd);
    }
    pids.add(row.pid);
  }
  return rows;
}

function assertPresentTerminalInspection({ cwd, projectIds, owner, controllerPids = [], reviewedNonwriters = [],
  requireEmptyContainers = false, reviewedListeners = [], retainedVolumes = [], successorPorts = [],
  captureListeners = false }) {
  check(process.platform === 'linux', 'present_terminal_linux_required');
  check(typeof cwd === 'string' && path.isAbsolute(cwd) && cwd !== '/' && fs.realpathSync(cwd) === cwd,
    'present_terminal_plain_cwd_required');
  check(typeof owner === 'string' && owner.trim() === owner && owner.length >= 3, 'present_terminal_owner_required');
  check(Array.isArray(projectIds) && projectIds.length > 0 && projectIds.every(value =>
    typeof value === 'string' && /^[a-zA-Z0-9_-]{3,128}$/.test(value)), 'present_terminal_project_ids_required');
  check(Array.isArray(controllerPids) && controllerPids.every(pid => Number.isSafeInteger(pid) && pid > 1),
    'present_terminal_controller_pids_invalid');
  validateReviewedNonwriters(reviewedNonwriters);
  check(typeof requireEmptyContainers === 'boolean', 'present_terminal_empty_containers_option_invalid');
  check(typeof captureListeners === 'boolean', 'present_terminal_listener_capture_option_invalid');
  reviewedListeners = validateReviewedListeners(reviewedListeners);
  check(!captureListeners || (requireEmptyContainers && reviewedListeners.length === 0),
    'present_terminal_listener_capture_mode_invalid');
  check(requireEmptyContainers || reviewedListeners.length === 0, 'present_terminal_listener_mode_required');
  check((retainedVolumes.length === 0 && successorPorts.length === 0) ||
    (retainedVolumes.length === 3 && successorPorts.length > 0 && requireEmptyContainers),
    'present_terminal_retained_volume_mode_invalid');
  if (retainedVolumes.length) retainedVolumes = validateRetainedVolumeStructure(retainedVolumes, projectIds[0]);
  if (successorPorts.length) successorPorts = validateSuccessorPorts(successorPorts);
  const source = `'use strict'; const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawnSync}=require('child_process');\n` +
    [check, withinPath, admitControllerParent, assertControllerParentUnchanged, processBlocksTerminality,
      validateRetainedVolumeStructure, validateRetainedVolumes, parseMountinfo, assertRetainedVolumeMounts,
      validateSuccessorPorts, assertSuccessorPortsUnbound, vanishedProcEntry, identity, sameIdentity, exactReader,
      registrationSymlinkTarget, terminalTransientUnit,
      validateReviewedNonwriters, validateReviewedListeners, readListenerSockets, assertEmptyContainers,
      captureReviewedListeners, inspect].map(fn => fn.toString()).join('\n') + '\ninspect();';
  // GNU timeout owns only this diagnostic child group. No runtime process is
  // signalled. spawnSync settles before the lease-store critical section returns.
  const controller = identity(process.pid);
  const controllerParent = controller.ppid > 1 ? identity(controller.ppid) : null;
  const result = spawnSync('/usr/bin/sudo', ['-n', '--', '/usr/bin/timeout', '--signal=KILL', '15s',
    process.execPath, '-e', source], { encoding: 'utf8', cwd: '/', input: JSON.stringify({ cwd, owner,
      projectIds, controllerPids, reviewedNonwriters, requireEmptyContainers, reviewedListeners,
      retainedVolumes, successorPorts, captureListeners,
      controller, controllerParent }),
    timeout: 20000, killSignal: 'SIGKILL', maxBuffer: 1024 * 1024,
    env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LANG: 'C' } });
  check(!result.error && result.status === 0 && !result.signal && !result.stderr.trim(), 'present_terminal_scan_failed:' +
    String(result.error?.code || result.stderr || result.signal || result.status).slice(0, 2048));
  const report = JSON.parse(result.stdout);
  check(report.scope === 'live-processes-and-direct-registrations-only' && report.dispatchExclusion === 'caller-required',
    'present_terminal_scan_report_invalid');
  if (requireEmptyContainers) {
    const reportedListeners = validateReviewedListeners(report.reviewedListeners);
    check(report.emptyContainers === true && (captureListeners ||
      JSON.stringify(reportedListeners) === JSON.stringify(reviewedListeners)), 'present_terminal_scan_report_invalid');
  }
  if (retainedVolumes.length) check(
    JSON.stringify(report.retainedVolumes) === JSON.stringify(retainedVolumes.map(row => row.name)) &&
    JSON.stringify(report.successorPorts) === JSON.stringify(successorPorts),
    'present_terminal_scan_report_invalid');
  return report;
}
function capturePresentTerminalListeners({ cwd, owner, projectId } = {}) {
  const canonicalCwd = fs.realpathSync(path.resolve(cwd || process.cwd()));
  const report = assertPresentTerminalInspection({
    cwd: canonicalCwd, owner, projectIds: [projectId], requireEmptyContainers: true,
    reviewedListeners: [], captureListeners: true,
  });
  return {
    command: 'present-terminal-listeners', inspected_at: report.inspectedAt,
    cwd: canonicalCwd, owner, project_id: projectId,
    reviewed_listeners: validateReviewedListeners(report.reviewedListeners),
    empty_containers: true,
  };
}

module.exports = { assertPresentTerminalInspection, capturePresentTerminalListeners, exactReader, terminalTransientUnit, registrationSymlinkTarget,
  validateReviewedNonwriters, validateReviewedListeners, readListenerSockets, assertEmptyContainers, captureReviewedListeners,
  vanishedProcEntry, validateRetainedVolumeStructure, validateRetainedVolumes, parseMountinfo, assertRetainedVolumeMounts,
  admitControllerParent, assertControllerParentUnchanged, processBlocksTerminality,
  validateSuccessorPorts, assertSuccessorPortsUnbound };
