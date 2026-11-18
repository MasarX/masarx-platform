#!/usr/bin/env node
// This scanner reports raw type literals that bypass the shared typography tokens.

'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..', '..', '..');
const SCAN_DIR = path.join(ROOT, 'apps', 'fieldops');

// Files exempt from scan: theme/policy SSOTs, type defs, and tests.
// These files ARE the policies (they define tokens) or they assert on policies,
// so raw numeric literals in them are intentional, not violations.
const EXEMPT_PATTERNS = [
  /mobile-theme\.ts$/,
  /-policy\.ts$/,
  /\.test\./,
  /__mocks__/,
  /\.types\.ts$/,
];

const TYPOGRAPHY_PROPS = ['fontSize', 'lineHeight', 'letterSpacing'];

function isExempt(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return EXEMPT_PATTERNS.some((pat) => pat.test(normalized));
}

function* walk(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_err) {
    return;
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* walk(full);
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      yield full;
    }
  }
}

function scanFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const findings = [];
  TYPOGRAPHY_PROPS.forEach((prop) => {
    const re = new RegExp(`\\b${prop}\\s*:\\s*(\\d+(?:\\.\\d+)?)\\b`, 'g');
    let m;
    while ((m = re.exec(content)) !== null) {
      const lineNo = content.slice(0, m.index).split('\n').length;
      findings.push({
        file: path.relative(ROOT, filePath).replace(/\\/g, '/'),
        line: lineNo,
        prop,
        raw_value: m[1],
      });
    }
  });
  return findings;
}

function main() {
  const args = process.argv.slice(2);
  const outIdx = args.indexOf('--out');
  const outFile = outIdx >= 0 ? args[outIdx + 1] : null;
  const findings = [];
  for (const file of walk(SCAN_DIR)) {
    if (isExempt(file)) continue;
    findings.push(...scanFile(file));
  }
  const summary = {
    scanned_at: new Date().toISOString(),
    scanned_dir: path.relative(ROOT, SCAN_DIR).replace(/\\/g, '/'),
    total_findings: findings.length,
    by_file: findings.reduce((acc, f) => {
      acc[f.file] = (acc[f.file] || 0) + 1;
      return acc;
    }, {}),
    by_prop: findings.reduce((acc, f) => {
      acc[f.prop] = (acc[f.prop] || 0) + 1;
      return acc;
    }, {}),
    findings,
  };
  const out = JSON.stringify(summary, null, 2);
  if (outFile) {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, out);
    // eslint-disable-next-line no-console
    console.log(`Wrote ${findings.length} findings to ${outFile}`);
  } else {
    // eslint-disable-next-line no-console
    console.log(out);
  }
}

if (require.main === module) main();

module.exports = { scanFile, walk, isExempt, TYPOGRAPHY_PROPS, EXEMPT_PATTERNS };
