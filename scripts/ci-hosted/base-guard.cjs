'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { git, targetBase } = require('./target-policy.cjs');

function guardPlan(entry, base, read = git) {
  if (!['migrations.cjs', 'jest.cjs'].includes(entry) || !/^[a-f0-9]{40}$/.test(base)) throw new Error('Invalid base guard identity');
  return [entry, 'target-policy.cjs', ...(entry === 'jest.cjs' ? ['diagnostics.cjs'] : [])].map(name => {
    const file = `scripts/ci-hosted/${name}`;
    if (!/^100644 blob [a-f0-9]{40}\t/.test(read(['ls-tree', '-z', base, '--', file]))) throw new Error('Base guard missing or not plain');
    return { name, content: read(['show', `${base}:${file}`], null) };
  });
}
function main() {
  const [entry, ...args] = process.argv.slice(2);
  const base = targetBase();
  if (entry === 'migrations.cjs' ? args.length !== 1 || args[0] !== base : args.length !== 1 || !['unit', 'ui'].includes(args[0])) {
    throw new Error('Invalid base guard arguments');
  }
  const files = guardPlan(entry, base);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hosted-base-guard-'));
  try {
    for (const file of files) fs.writeFileSync(path.join(temp, file.name), file.content, { mode: 0o600 });
    console.log(`Using guard code from target base ${base}`);
    const result = spawnSync(process.execPath, [path.join(temp, entry), ...args], { stdio: 'inherit', env: process.env, timeout: 30 * 60000 });
    if (result.error || result.status === null) throw new Error('Base guard execution failed');
    process.exitCode = result.status;
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}
if (require.main === module) { try { main(); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { guardPlan };
