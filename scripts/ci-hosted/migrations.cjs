'use strict';
const crypto = require('node:crypto');
const { git, targetFile } = require('./target-policy.cjs');
const prefix = 'supabase/migrations/';
const filename = /^\d+_[a-zA-Z0-9_.-]+\.sql$/;
function expiryDate(value, now = new Date()) {
  const date = new Date(value);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value
    || value < now.toISOString().slice(0, 10)) throw new Error('Malformed or expired migration exception expiry');
  return value;
}
function exceptions(text, now = new Date()) {
  const allowed = new Map();
  if (!text.split(/\r?\n/).some(line => line.trim() && !line.trim().startsWith('#'))) return allowed;
  let expiry;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('expires ')) {
      if (expiry) throw new Error('Duplicate migration exception expiry');
      expiry = expiryDate(line.slice(8), now); continue;
    }
    const match = /^(\d+_[a-zA-Z0-9_.-]+\.sql) ([a-f0-9]{64})$/.exec(line);
    if (!match || allowed.has(match[1])) throw new Error('Malformed/duplicate migration exception; exact basename and SHA-256 required');
    allowed.set(match[1], match[2]);
  }
  if (!expiry) throw new Error('Migration exception file requires an explicit expiry');
  return allowed;
}
function orderFloor(baseFiles) {
  const names = baseFiles.filter(file => file.startsWith(prefix) && filename.test(file.slice(prefix.length))).map(file => file.slice(prefix.length));
  const stamps = names.map(name => name.split('_')[0]);
  return { numeric: stamps.reduce((max, stamp) => BigInt(stamp) > max ? BigInt(stamp) : max, -1n),
    stamp: stamps.reduce((max, stamp) => stamp > max ? stamp : max, ''), name: names.reduce((max, name) => name > max ? name : max, '') };
}
function outOfOrder(name, floor) {
  if (!filename.test(name)) return true;
  const stamp = name.split('_')[0];
  return BigInt(stamp) <= floor.numeric || stamp <= floor.stamp || name <= floor.name;
}
function assess(baseFiles, changes, allowed, objects) {
  const floor = orderFloor(baseFiles);
  const failed = []; const tolerated = []; const added = new Set();
  for (const [status, file] of changes) {
    const name = file.slice(prefix.length);
    const valid = file.startsWith(prefix) && filename.test(name);
    const object = objects.get(file);
    if (['A', 'M'].includes(status) && object?.mode !== '100644') { failed.push(`${status}: ${file} (not a plain 100644 file)`); continue; }
    if (status === 'A' && valid) {
      const stamp = BigInt(name.split('_')[0]).toString();
      if (added.has(stamp)) { failed.push(`duplicate stamp: ${file}`); continue; }
      added.add(stamp);
    }
    const oldAddition = status === 'A' && (!valid || outOfOrder(name, floor));
    if (status === 'A' && !oldAddition) continue;
    if (valid && allowed.has(name) && /^[a-f0-9]{64}$/.test(object?.digest || '') && allowed.get(name) === object.digest && (status === 'M' || oldAddition)) tolerated.push(file);
    else failed.push(`${status}: ${file}`);
  }
  return { failed, tolerated, last: floor.numeric.toString(), lastStamp: floor.stamp, lastName: floor.name };
}
function objectsAt(revision, changes, read = git) {
  const objects = new Map();
  for (const line of read(['ls-tree', '-r', '-z', revision, '--', prefix]).split('\0').filter(Boolean)) {
    const tab = line.indexOf('\t');
    const [mode, type, blob] = line.slice(0, tab).split(' ');
    objects.set(line.slice(tab + 1), { mode, type, blob });
  }
  const selected = [...new Set(changes.filter(([status]) => ['A', 'M'].includes(status)).map(([, file]) => file))]
    .filter(file => objects.get(file)?.mode === '100644');
  if (selected.length) {
    const input = selected.map(file => objects.get(file).blob).join('\n') + '\n';
    const raw = read(['cat-file', '--batch'], null, input);
    let offset = 0;
    for (const file of selected) {
      const end = raw.indexOf(10, offset);
      const [id, type, size] = raw.subarray(offset, end).toString('ascii').split(' ');
      if (end < 0 || id !== objects.get(file).blob || type !== 'blob' || !/^\d+$/.test(size)) throw new Error('Invalid migration blob response');
      const length = Number(size); const start = end + 1;
      if (!Number.isSafeInteger(length) || start + length >= raw.length || raw[start + length] !== 10) throw new Error('Truncated migration content');
      objects.get(file).digest = crypto.createHash('sha256').update(raw.subarray(start, start + length)).digest('hex');
      offset = start + length + 1;
    }
    if (offset !== raw.length) throw new Error('Unexpected migration batch content');
  }
  return objects;
}
function main() {
  const base = process.argv[2];
  if (!/^[a-f0-9]{40}$/.test(base || '')) throw new Error('Invalid migration base SHA');
  const baseFiles = git(['ls-tree', '-r', '--name-only', '-z', base, '--', prefix]).split('\0').filter(Boolean);
  const fields = git(['diff', '--no-renames', '--name-status', '-z', base, 'HEAD', '--', prefix]).split('\0').filter(Boolean);
  if (fields.length % 2) throw new Error('Malformed migration diff');
  const changes = [];
  for (let i = 0; i < fields.length; i += 2) changes.push([fields[i], fields[i + 1]]);
  const allowed = exceptions(targetFile('config/ci/migration-append-only-exceptions.txt', base));
  const verdict = assess(baseFiles, changes, allowed, objectsAt('HEAD', changes));
  for (const file of verdict.tolerated) console.log(`TOLERATED content-bound migration exception from target: ${file}`);
  for (const file of verdict.failed) console.error(`Append-only violation: ${JSON.stringify(file)}`);
  if (verdict.failed.length) throw new Error('Migration append-only check failed');
  console.log('PASS: migration order, plain-file modes and expiring content-bound exceptions');
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { exceptions, assess, objectsAt, orderFloor, outOfOrder, expiryDate };
