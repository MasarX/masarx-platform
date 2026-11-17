'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { orderFloor, outOfOrder, expiryDate } = require('./migrations.cjs');
function inventory(tree) {
  const directory = path.join(tree, 'supabase/migrations');
  const rows = new Map();
  for (const name of fs.readdirSync(directory).sort()) {
    if (!name.endsWith('.sql')) continue;
    const file = path.join(directory, name); const stat = fs.lstatSync(file);
    if (!/^\d+_[a-zA-Z0-9_.-]+\.sql$/.test(name) || !stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o111)) {
      throw new Error(`Migration is not a plain non-executable SQL file: ${name}`);
    }
    rows.set(name, crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'));
  }
  return rows;
}
function generate(main, v2, expiry, now = new Date()) {
  expiryDate(expiry, now);
  const floor = orderFloor([...main.keys()].map(name => `supabase/migrations/${name}`));
  for (const name of main.keys()) if (!v2.has(name)) throw new Error(`Deletion/rename is not exceptionable: ${name}`);
  const lines = []; const stamps = new Set();
  for (const [name, digest] of [...v2].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)) {
    if (!/^\d+_[a-zA-Z0-9_.-]+\.sql$/.test(name) || !/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid v2 migration inventory');
    const stamp = BigInt(name.split('_')[0]).toString();
    if (stamps.has(stamp)) throw new Error(`Duplicate v2 stamp: ${name}`);
    stamps.add(stamp);
    if (main.has(name) ? main.get(name) !== digest : outOfOrder(name, floor)) lines.push(`${name} ${digest}`);
  }
  return [`expires ${expiry}`, ...lines, ''].join('\n');
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length !== 3) throw new Error('Usage: node generate-migration-exceptions.cjs <main-tree> <v2-tree> <YYYY-MM-DD>; output is stdout');
    process.stdout.write(generate(inventory(args[0]), inventory(args[1]), args[2]));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { inventory, generate };
