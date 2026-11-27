'use strict';
const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { configuredExclusions } = require('./nightly-result.cjs');

function coverageGaps(inventory, script, exclusions) {
  const declared = new Set([
    ...[...script.matchAll(/^[ \t]*# nightly-covers:[ \t]+([^\r\n]+)/gm)].flatMap(match => match[1].trim().split(/\s+/)),
    ...[...script.matchAll(/\b(RUN_[A-Z0-9_]+)=(?:true|1)\b/g)].map(match => match[1]),
    ...exclusions.flatMap(row => [...(row.flags || []), ...(row.suites || [])]),
  ]);
  return [...new Set(inventory)].filter(name => !declared.has(name));
}

function checkInventory() {
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const read = file => fs.readFileSync(file, 'utf8');
  const inventory = files.filter(file => /(?:^|\/)playwright[^/]*\.config\.(?:ts|cjs)$/.test(file));
  for (const file of files) {
    if (/(?:^|\/)package\.json$/.test(file)) {
      inventory.push(...Object.keys(JSON.parse(read(file)).scripts || {}).filter(name => name.startsWith('test:')));
    }
    if (/^(?:tests\/|apps\/[^/]+\/tests\/).+\.[cm]?[jt]sx?$/.test(file)) {
      inventory.push(...[...read(file).matchAll(/\b(?:process\.)?env\.((?:RUN_)[A-Z0-9_]+)\b/g)].map(match => match[1]));
    }
  }
  return coverageGaps(inventory, read('scripts/ci/nightly-suites.sh'), configuredExclusions());
}

if (require.main === module) {
  const gaps = checkInventory();
  if (gaps.length) {
    console.error('Nightly suite has no run or exclusion for: ' + gaps.join(', '));
    process.exitCode = 1;
  }
}

module.exports = { checkInventory, coverageGaps };
