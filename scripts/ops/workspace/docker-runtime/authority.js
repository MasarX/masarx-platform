'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const AUTHORITY_VERSION = 1;
const FILE_MODE = 0o600;
const DIRECTORY_MODE = 0o700;
const MAX_RECEIPT_BYTES = 256 * 1024;

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function currentUid() {
  return typeof process.getuid === 'function' ? process.getuid() : null;
}

function normalizedMode(stat) {
  return stat.mode & 0o777;
}

function sameIdentity(left, right) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.uid === right.uid
    && left.nlink === right.nlink
    && normalizedMode(left) === normalizedMode(right);
}

function assertOwnedDirectory(directory, { mode = null, label = 'directory', fsImpl } = {}) {
  const fs = fsImpl || require('fs');
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`docker_runtime_authority_${label}_invalid`);
  }
  const uid = currentUid();
  if (uid !== null && stat.uid !== uid) {
    throw new Error(`docker_runtime_authority_${label}_owner_mismatch`);
  }
  if (mode !== null && normalizedMode(stat) !== mode) {
    throw new Error(`docker_runtime_authority_${label}_mode_mismatch`);
  }
  return stat;
}

function assertNoSymlinkPathComponents(target, { fsImpl } = {}) {
  const fs = fsImpl || require('fs');
  const absolute = path.resolve(target);
  const parsed = path.parse(absolute);
  let current = parsed.root;
  for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if (error?.code === 'ENOENT') break;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('docker_runtime_authority_path_component_invalid');
    }
  }
  return absolute;
}

function admitPrivateBundleDirectory(directory, { create = false } = {}) {
  const absolute = path.resolve(directory);
  const parsed = path.parse(absolute);
  const segments = absolute.slice(parsed.root.length).split(path.sep).filter(Boolean);
  const markerIndex = segments.lastIndexOf('docker-runtime-authority');
  const firstPrivateIndex = markerIndex >= 0 ? markerIndex : segments.length - 1;
  const trustedParent = path.join(parsed.root, ...segments.slice(0, firstPrivateIndex));
  assertNoSymlinkPathComponents(trustedParent);
  assertOwnedDirectory(trustedParent, { label: 'lease_store' });

  let current = trustedParent;
  for (const segment of segments.slice(firstPrivateIndex)) {
    current = path.join(current, segment);
    if (create) {
      try {
        fs.mkdirSync(current, { mode: DIRECTORY_MODE });
      } catch (error) {
        if (error?.code !== 'EEXIST') throw error;
      }
    }
    assertOwnedDirectory(current, { mode: DIRECTORY_MODE, label: 'namespace' });
  }
  return assertOwnedDirectory(absolute, { mode: DIRECTORY_MODE, label: 'bundle' });
}

function ensurePrivateBundleDirectory(directory) {
  return admitPrivateBundleDirectory(directory, { create: true });
}

function isWithin(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative));
}

function assertAuthorityOutsideBindSources(authorityRoot, bindSources = []) {
  const resolvedRoot = path.resolve(authorityRoot);
  for (const rawSource of bindSources) {
    if (!rawSource) continue;
    const resolvedSource = path.resolve(String(rawSource));
    const source = fs.existsSync(resolvedSource) ? fs.realpathSync(resolvedSource) : resolvedSource;
    if (isWithin(source, resolvedRoot) || isWithin(resolvedRoot, source)) {
      throw new Error('docker_runtime_authority_inside_candidate_bind');
    }
  }
  return resolvedRoot;
}

function safeSegment(value, label) {
  const segment = String(value || '').trim();
  if (!segment || segment === '.' || segment === '..' || !/^[A-Za-z0-9._-]+$/.test(segment)) {
    throw new Error(`docker_runtime_authority_${label}_invalid`);
  }
  return segment;
}

function authorityRemovalTombstonePath(proof = {}) {
  const receiptPath = path.resolve(String(proof.receiptPath || proof.receipt_path || ''));
  const directory = path.resolve(String(proof.directory || path.dirname(receiptPath)));
  const receiptSha256 = String(proof.receiptSha256 || proof.receipt_sha256 || '').trim();
  if (
    path.dirname(receiptPath) !== directory
    || path.basename(receiptPath) !== 'receipt.json'
    || !/^[0-9a-f]{64}$/.test(receiptSha256)
  ) throw new Error('docker_runtime_authority_removal_proof_invalid');
  return path.join(
    path.dirname(directory),
    `.${path.basename(directory)}.removing-${receiptSha256}`,
  );
}

function assertNoAuthorityRemovalTombstones(parentDirectory) {
  try {
    const entry = fs.readdirSync(parentDirectory)
      .find((name) => name.includes('.removing-'));
    if (entry) throw new Error('docker_runtime_authority_removal_in_progress');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

function resolveRuntimeAuthorityPaths({
  leaseDir,
  cwd,
  workspaceId,
  composeProjectName,
  bindSources = [],
} = {}) {
  const requestedLeaseDir = path.resolve(String(leaseDir || ''));
  assertNoSymlinkPathComponents(requestedLeaseDir);
  if (fs.existsSync(requestedLeaseDir)) {
    assertOwnedDirectory(requestedLeaseDir, { label: 'lease_store' });
  }
  const workspace = safeSegment(workspaceId, 'workspace');
  const composeProject = safeSegment(composeProjectName, 'compose_project');
  const authorityBase = path.join(requestedLeaseDir, 'docker-runtime-authority');
  const workspaceRoot = path.join(authorityBase, workspace);
  const root = path.join(workspaceRoot, composeProject);
  if (
    path.dirname(workspaceRoot) !== authorityBase
    || path.dirname(root) !== workspaceRoot
  ) {
    throw new Error('docker_runtime_authority_namespace_escape');
  }
  assertAuthorityOutsideBindSources(root, [cwd, ...bindSources]);
  const persistentDir = path.join(root, 'persistent');
  const transientDir = path.join(root, 'transient');
  return {
    root,
    persistentDir,
    transientDir,
    receiptFile: path.join(persistentDir, 'receipt.json'),
    runtimeEnvFile: path.join(persistentDir, 'runtime.env'),
    dependencyEnvFile: path.join(persistentDir, 'workspace-deps.env'),
    composeFile: path.join(persistentDir, 'compose.yaml'),
    composeConfigFile: path.join(persistentDir, 'compose.rendered.json'),
    authManifestFile: path.join(persistentDir, 'demo-accounts.json'),
    authPasswordFile: path.join(persistentDir, 'EXAMPLE_PASSWORD'),
  };
}

function fsyncDirectory(directory) {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY);
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function pruneEmptyAuthorityNamespace({ root, persistentDir, transientDir } = {}) {
  const composeRoot = path.resolve(String(root || ''));
  const persistent = path.resolve(String(persistentDir || ''));
  const transient = path.resolve(String(transientDir || ''));
  const workspaceRoot = path.dirname(composeRoot);
  const authorityBase = path.dirname(workspaceRoot);
  if (
    !root || !persistentDir || !transientDir
    || persistent !== path.join(composeRoot, 'persistent')
    || transient !== path.join(composeRoot, 'transient')
    || path.basename(authorityBase) !== 'docker-runtime-authority'
  ) throw new Error('docker_runtime_authority_prune_paths_invalid');

  const inspect = (directory, label) => ({
    stat: assertOwnedDirectory(directory, { mode: DIRECTORY_MODE, label: `prune_${label}` }),
    entries: fs.readdirSync(directory).sort(),
  });
  const inspectIfPresent = (directory, label) => {
    try {
      return inspect(directory, label);
    } catch (error) {
      if (error?.code === 'ENOENT') return null;
      throw error;
    }
  };
  const remove = (directory, before, expectedEntries, label) => {
    const current = inspect(directory, label);
    if (
      current.stat.dev !== before.dev || current.stat.ino !== before.ino
      || current.stat.uid !== before.uid || normalizedMode(current.stat) !== normalizedMode(before)
      || JSON.stringify(current.entries) !== JSON.stringify(expectedEntries)
    ) throw new Error(`docker_runtime_authority_prune_${label}_changed`);
    try {
      fs.rmdirSync(directory);
    } catch (error) {
      throw new Error(
        `docker_runtime_authority_prune_${label}_remove_race:${error?.code || 'unknown'}`,
      );
    }
    fsyncDirectory(path.dirname(directory));
  };

  assertNoSymlinkPathComponents(authorityBase);
  if (!inspectIfPresent(authorityBase, 'base')) {
    return { pruned: [], reason: 'namespace_absent' };
  }
  const workspace = inspectIfPresent(workspaceRoot, 'workspace');
  if (!workspace) {
    fsyncDirectory(authorityBase);
    return { pruned: [], reason: 'namespace_absent' };
  }

  try {
    fs.lstatSync(persistent);
    throw new Error('docker_runtime_authority_prune_persistent_present');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const pruned = [];
  const compose = inspectIfPresent(composeRoot, 'compose');
  if (compose) {
    const transientState = inspectIfPresent(transient, 'transient');
    if (transientState?.entries.length) {
      throw new Error('docker_runtime_authority_prune_transient_nonempty');
    }
    const composeExpected = transientState ? [path.basename(transient)] : [];
    if (JSON.stringify(compose.entries) !== JSON.stringify(composeExpected)) {
      throw new Error('docker_runtime_authority_prune_compose_nonempty');
    }
    if (transientState) {
      remove(transient, transientState.stat, [], 'transient');
      pruned.push(transient);
    }
    remove(composeRoot, compose.stat, [], 'compose');
    pruned.push(composeRoot);
  }

  const currentWorkspace = inspect(workspaceRoot, 'workspace');
  if (currentWorkspace.entries.length === 0) {
    remove(workspaceRoot, workspace.stat, [], 'workspace');
    pruned.push(workspaceRoot);
  }
  return { pruned };
}

function writeAtomicFile(filePath, bytes) {
  const directory = path.dirname(filePath);
  const basename = path.basename(filePath);
  const temp = path.join(directory, `.${basename}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
  const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
    | (fs.constants.O_NOFOLLOW || 0);
  const fd = fs.openSync(temp, flags, FILE_MODE);
  try {
    fs.fchmodSync(fd, FILE_MODE);
    let offset = 0;
    while (offset < bytes.length) {
      offset += fs.writeSync(fd, bytes, offset, bytes.length - offset, offset);
    }
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(temp, filePath);
  fsyncDirectory(directory);
}

function readStableAuthorityFile(filePath, maxBytes, expected = null, options = {}) {
  const fs = options.fsImpl || require('fs');
  let before;
  try {
    before = fs.lstatSync(filePath);
  } catch {
    throw new Error(`docker_runtime_authority_file_missing:${path.basename(filePath)}`);
  }
  if (!before.isFile() || before.isSymbolicLink() || before.size <= 0 || before.size > maxBytes) {
    throw new Error(`docker_runtime_authority_file_invalid:${path.basename(filePath)}`);
  }
  const uid = currentUid();
  if (
    normalizedMode(before) !== FILE_MODE
    || before.nlink !== 1
    || (uid !== null && before.uid !== uid)
  ) {
    throw new Error(`docker_runtime_authority_file_identity_invalid:${path.basename(filePath)}`);
  }
  const fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (!sameIdentity(before, opened)) {
      throw new Error(`docker_runtime_authority_file_open_race:${path.basename(filePath)}`);
    }
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const count = fs.readSync(fd, bytes, offset, bytes.length - offset, offset);
      if (count <= 0) break;
      offset += count;
    }
    if (offset !== bytes.length) {
      throw new Error(`docker_runtime_authority_file_short_read:${path.basename(filePath)}`);
    }
    const afterFd = fs.fstatSync(fd);
    const afterPath = fs.lstatSync(filePath);
    if (!sameIdentity(opened, afterFd) || !sameIdentity(opened, afterPath)) {
      throw new Error(`docker_runtime_authority_file_changed:${path.basename(filePath)}`);
    }
    const digest = sha256(bytes);
    if (expected && (
      expected.sha256 !== digest
      || Number(expected.bytes) !== bytes.length
      || Number(expected.dev) !== Number(opened.dev)
      || Number(expected.ino) !== Number(opened.ino)
      || Number(expected.uid) !== Number(opened.uid)
      || Number(expected.nlink) !== Number(opened.nlink)
      || Number(expected.mode) !== normalizedMode(opened)
    )) {
      throw new Error(`docker_runtime_authority_file_receipt_mismatch:${path.basename(filePath)}`);
    }
    return {
      bytes,
      proof: {
        sha256: digest,
        bytes: bytes.length,
        dev: Number(opened.dev),
        ino: Number(opened.ino),
        mode: normalizedMode(opened),
        uid: Number(opened.uid),
        nlink: Number(opened.nlink),
      },
    };
  } finally {
    fs.closeSync(fd);
  }
}

function publishAuthorityBundle({
  directory,
  context,
  files,
  parentReceiptSha256 = '',
  kind = 'persistent',
} = {}) {
  assertNoAuthorityRemovalTombstones(path.dirname(directory));
  ensurePrivateBundleDirectory(directory);
  if (fs.readdirSync(directory).length !== 0) {
    throw new Error('docker_runtime_authority_bundle_already_exists');
  }
  const fileProofs = {};
  for (const [logicalName, entry] of Object.entries(files || {})) {
    const basename = path.basename(String(entry.basename || logicalName));
    if (basename !== String(entry.basename || logicalName)) {
      throw new Error(`docker_runtime_authority_file_name_invalid:${logicalName}`);
    }
    const bytes = Buffer.isBuffer(entry.bytes) ? entry.bytes : Buffer.from(String(entry.bytes || ''), 'utf8');
    const maxBytes = Number(entry.maxBytes || 8 * 1024 * 1024);
    if (!bytes.length || bytes.length > maxBytes) {
      throw new Error(`docker_runtime_authority_file_size_invalid:${logicalName}`);
    }
    const filePath = path.join(directory, basename);
    writeAtomicFile(filePath, bytes);
    const stable = readStableAuthorityFile(filePath, maxBytes);
    fileProofs[logicalName] = {
      logical_name: logicalName,
      basename,
      ...stable.proof,
    };
  }
  const receipt = {
    version: AUTHORITY_VERSION,
    kind,
    ...context,
    parent_receipt_sha256: String(parentReceiptSha256 || ''),
    files: Object.values(fileProofs),
  };
  const receiptPath = path.join(directory, 'receipt.json');
  const receiptBytes = Buffer.from(`${JSON.stringify(receipt, null, 2)}\n`, 'utf8');
  writeAtomicFile(receiptPath, receiptBytes);
  const receiptProof = readStableAuthorityFile(receiptPath, MAX_RECEIPT_BYTES);
  return {
    directory,
    receiptPath,
    receiptSha256: receiptProof.proof.sha256,
    receipt,
    fileProofs,
  };
}

function readAuthorityBundle({
  receiptPath,
  expectedContext = {},
  expectedKind = 'persistent',
  maxBytesByName = {},
  requiredFiles = null,
} = {}) {
  const directory = path.dirname(receiptPath);
  admitPrivateBundleDirectory(directory);
  const receiptRead = readStableAuthorityFile(receiptPath, MAX_RECEIPT_BYTES);
  let receipt;
  try {
    receipt = JSON.parse(receiptRead.bytes.toString('utf8'));
  } catch {
    throw new Error('docker_runtime_authority_receipt_invalid_json');
  }
  if (receipt.version !== AUTHORITY_VERSION || receipt.kind !== expectedKind) {
    throw new Error('docker_runtime_authority_receipt_contract_mismatch');
  }
  for (const [key, expected] of Object.entries(expectedContext || {})) {
    if (String(receipt[key] ?? '') !== String(expected ?? '')) {
      throw new Error(`docker_runtime_authority_context_mismatch:${key}`);
    }
  }
  if (!Array.isArray(receipt.files) || receipt.files.length === 0) {
    throw new Error('docker_runtime_authority_receipt_files_invalid');
  }
  const bytesByName = {};
  const fileProofs = {};
  const seen = new Set();
  const seenBasenames = new Set();
  for (const expected of receipt.files) {
    const logicalName = String(expected.logical_name || '');
    const basename = path.basename(String(expected.basename || ''));
    if (
      !logicalName || !basename || basename !== String(expected.basename || '')
      || seen.has(logicalName) || seenBasenames.has(basename)
    ) {
      throw new Error('docker_runtime_authority_receipt_file_entry_invalid');
    }
    seen.add(logicalName);
    seenBasenames.add(basename);
    const stable = readStableAuthorityFile(
      path.join(directory, basename),
      Number(maxBytesByName[logicalName] || 8 * 1024 * 1024),
      expected,
    );
    bytesByName[logicalName] = stable.bytes;
    fileProofs[logicalName] = stable.proof;
  }
  if (requiredFiles) {
    const requiredEntries = Object.entries(requiredFiles);
    if (
      requiredEntries.length !== seen.size
      || requiredEntries.some(([logicalName, basename]) => (
        !seen.has(logicalName)
        || String(receipt.files.find((entry) => entry.logical_name === logicalName)?.basename || '') !== basename
      ))
    ) {
      throw new Error('docker_runtime_authority_receipt_file_set_mismatch');
    }
  }
  const expectedInventory = [...seenBasenames, path.basename(receiptPath)].sort();
  const actualInventory = fs.readdirSync(directory).sort();
  if (JSON.stringify(actualInventory) !== JSON.stringify(expectedInventory)) {
    throw new Error('docker_runtime_authority_directory_inventory_mismatch');
  }
  return {
    receipt,
    receiptSha256: receiptRead.proof.sha256,
    bytesByName,
    fileProofs,
    directory,
    receiptPath,
  };
}

function parseRemovalReceipt(receiptRead, options = {}) {
  let receipt;
  try {
    receipt = JSON.parse(receiptRead.bytes.toString('utf8'));
  } catch {
    throw new Error('docker_runtime_authority_receipt_invalid_json');
  }
  if (receipt.version !== AUTHORITY_VERSION || !Array.isArray(receipt.files) || !receipt.files.length) {
    throw new Error('docker_runtime_authority_receipt_contract_mismatch');
  }
  const expectedKinds = options.expectedKinds || [];
  if (expectedKinds.length && !expectedKinds.includes(receipt.kind)) {
    throw new Error('docker_runtime_authority_receipt_contract_mismatch');
  }
  for (const [key, expected] of Object.entries(options.expectedContext || {})) {
    if (String(receipt[key] ?? '') !== String(expected ?? '')) {
      throw new Error(`docker_runtime_authority_context_mismatch:${key}`);
    }
  }
  const logicalNames = new Set();
  const basenames = new Set();
  for (const entry of receipt.files) {
    const logicalName = String(entry.logical_name || '');
    const basename = path.basename(String(entry.basename || ''));
    if (
      !logicalName || !basename || basename !== String(entry.basename || '')
      || logicalNames.has(logicalName) || basenames.has(basename)
    ) throw new Error('docker_runtime_authority_receipt_file_entry_invalid');
    logicalNames.add(logicalName);
    basenames.add(basename);
  }
  return { receipt, basenames };
}

function removeAuthorityBundleCas(proof, options = {}) {
  const directory = path.resolve(String(proof?.directory || ''));
  const receiptPath = path.resolve(String(proof?.receiptPath || proof?.receipt_path || ''));
  const receiptSha256 = String(proof?.receiptSha256 || proof?.receipt_sha256 || '').trim();
  const tombstone = authorityRemovalTombstonePath({ directory, receiptPath, receiptSha256 });
  const parentDirectory = path.dirname(directory);
  const present = (target) => {
    try {
      fs.lstatSync(target);
      return true;
    } catch (error) {
      if (error?.code === 'ENOENT') return false;
      throw error;
    }
  };
  const canonicalPresent = present(directory);
  const tombstonePresent = present(tombstone);
  if (canonicalPresent && tombstonePresent) {
    throw new Error('docker_runtime_authority_removal_state_conflict');
  }
  if (!canonicalPresent && !tombstonePresent) {
    assertNoSymlinkPathComponents(parentDirectory);
    assertOwnedDirectory(parentDirectory, {
      mode: DIRECTORY_MODE,
      label: 'removal_parent',
    });
    fsyncDirectory(parentDirectory);
    return true;
  }

  if (canonicalPresent) {
    const before = admitPrivateBundleDirectory(directory);
    const current = readStableAuthorityFile(receiptPath, MAX_RECEIPT_BYTES);
    if (current.proof.sha256 !== receiptSha256) {
      throw new Error('docker_runtime_authority_cas_mismatch');
    }
    const parsed = parseRemovalReceipt(current, options);
    for (const entry of parsed.receipt.files) {
      readStableAuthorityFile(path.join(directory, entry.basename), 8 * 1024 * 1024, entry);
    }
    const expectedInventory = [...parsed.basenames, 'receipt.json'].sort();
    if (JSON.stringify(fs.readdirSync(directory).sort()) !== JSON.stringify(expectedInventory)) {
      throw new Error('docker_runtime_authority_directory_inventory_mismatch');
    }
    fs.renameSync(directory, tombstone);
    fsyncDirectory(path.dirname(directory));
    if (!sameIdentity(before, admitPrivateBundleDirectory(tombstone))) {
      throw new Error('docker_runtime_authority_removal_directory_changed');
    }
  }

  admitPrivateBundleDirectory(tombstone);
  const tombstoneReceipt = path.join(tombstone, 'receipt.json');
  if (present(tombstoneReceipt)) {
    const current = readStableAuthorityFile(tombstoneReceipt, MAX_RECEIPT_BYTES);
    if (current.proof.sha256 !== receiptSha256) {
      throw new Error('docker_runtime_authority_cas_mismatch');
    }
    const parsed = parseRemovalReceipt(current, options);
    const inventory = fs.readdirSync(tombstone).sort();
    const allowed = new Set([...parsed.basenames, 'receipt.json']);
    if (!inventory.includes('receipt.json') || inventory.some((entry) => !allowed.has(entry))) {
      throw new Error('docker_runtime_authority_directory_inventory_mismatch');
    }
    const remaining = parsed.receipt.files.filter((entry) => inventory.includes(entry.basename));
    for (const entry of remaining) {
      readStableAuthorityFile(path.join(tombstone, entry.basename), 8 * 1024 * 1024, entry);
    }
    for (const entry of remaining) fs.unlinkSync(path.join(tombstone, entry.basename));
    fsyncDirectory(tombstone);
    fs.unlinkSync(tombstoneReceipt);
    fsyncDirectory(tombstone);
  } else {
    if (fs.readdirSync(tombstone).length !== 0) {
      throw new Error('docker_runtime_authority_removal_receipt_missing');
    }
    fsyncDirectory(tombstone);
  }
  try {
    fs.rmdirSync(tombstone);
  } catch (error) {
    throw new Error(`docker_runtime_authority_removal_rmdir_failed:${error?.code || 'unknown'}`);
  }
  fsyncDirectory(parentDirectory);
  return true;
}

function recoverAuthorityRemovalTombstones({
  parentDirectory,
  expectedContext = {},
  expectedKinds = [],
  allowedBasenamePrefixes = [],
} = {}) {
  let entries;
  try {
    admitPrivateBundleDirectory(parentDirectory);
    entries = fs.readdirSync(parentDirectory).filter((entry) => entry.includes('.removing-')).sort();
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const recovered = [];
  for (const entry of entries) {
    const match = /^\.([A-Za-z0-9][A-Za-z0-9._-]*)\.removing-([0-9a-f]{64})$/.exec(entry);
    if (!match || !allowedBasenamePrefixes.some((prefix) => match[1].startsWith(prefix))) {
      throw new Error('docker_runtime_authority_removal_tombstone_invalid');
    }
    const original = path.join(parentDirectory, match[1]);
    removeAuthorityBundleCas({
      directory: original,
      receiptPath: path.join(original, 'receipt.json'),
      receiptSha256: match[2],
    }, { expectedContext, expectedKinds });
    recovered.push(entry);
  }
  return recovered;
}

function assertAuthorityBundleRemovalComplete(proof) {
  if (fs.existsSync(path.resolve(String(proof?.directory || '')))
    || fs.existsSync(authorityRemovalTombstonePath(proof))) {
    throw new Error('docker_runtime_authority_removal_incomplete');
  }
  return true;
}

module.exports = {
  assertNoSymlinkPathComponents,
  assertOwnedDirectory,
  assertAuthorityBundleRemovalComplete,
  admitPrivateBundleDirectory,
  assertAuthorityOutsideBindSources,
  authorityRemovalTombstonePath,
  ensurePrivateBundleDirectory,
  publishAuthorityBundle,
  pruneEmptyAuthorityNamespace,
  readAuthorityBundle,
  readStableAuthorityFile,
  recoverAuthorityRemovalTombstones,
  removeAuthorityBundleCas,
  resolveRuntimeAuthorityPaths,
};
