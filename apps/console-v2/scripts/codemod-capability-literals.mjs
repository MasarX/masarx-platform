#!/usr/bin/env node
// codemod-capability-literals.mjs — replace inline `capability="X"` and
// `useCapability('X')` literals in apps/console-v2 modules with the
// canonical typed `CAP.<KEY>` references from `src/lib/capabilities.ts`.
//
// Wave 10 of the console-v2 100% production-readiness closure loop.
// Closes the AGENTS.md §4 (SSOT) violation surfaced by the Wave 6 audit:
// inline string literals across ~229 occurrences bypass the canonical
// CAP bridge.
//
// Strategy:
//   1. Scan every `.tsx` file under apps/console-v2/src/modules/.
//   2. For each `capability="<dotted>"` literal: replace with
//      `capability={CAP.<UPPER_SNAKE>}`.
//   3. For each `useCapability('<dotted>')` call: replace with
//      `useCapability(CAP.<UPPER_SNAKE>)`.
//   4. For each `<CapabilityLock capability="<dotted>" />`: replace with
//      `<CapabilityLock capability={CAP.<UPPER_SNAKE>} />`.
//   5. After mutating any file, ensure it imports `CAP` from
//      `@/lib/capabilities`. Insert near the other `@/lib/*` imports.
//   6. Verify the resulting `<UPPER_SNAKE>` is a key on `CAP`. If not,
//      surface it (likely an FE_ONLY_PENDING / drift case from
//      lint-capabilities.mjs that needs the seed registry first).
//
// Usage:
//   node scripts/codemod-capability-literals.mjs           # dry run
//   node scripts/codemod-capability-literals.mjs --write   # apply
//
// Exit codes:
//   0 — success
//   1 — drift detected (literal references a key not in CAP)

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const MODULES_DIR = join(APP_ROOT, 'src', 'modules');
const CAPABILITIES_TS = join(APP_ROOT, 'src', 'lib', 'capabilities.ts');

const writeMode = process.argv.includes('--write');

// Parse CAP keys from src/lib/capabilities.ts so we know which keys exist.
function loadCapKeys() {
  const text = readFileSync(CAPABILITIES_TS, 'utf8');
  const out = new Map(); // 'foo.bar' -> 'FOO_BAR'
  const re = /^\s*([A-Z][A-Z0-9_]*)\s*:\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)',?$/gm;
  let m;
  while ((m = re.exec(text)) !== null) {
    out.set(m[2], m[1]);
  }
  return out;
}

const CAP_KEYS = loadCapKeys();
if (CAP_KEYS.size === 0) {
  console.error('[codemod] could not parse CAP keys from capabilities.ts');
  process.exit(2);
}
console.log(`[codemod] loaded ${CAP_KEYS.size} CAP keys`);

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && full.endsWith('.tsx')) {
      // Skip tests — they often deliberately pass invalid keys.
      if (full.includes('__tests__')) continue;
      if (full.endsWith('.test.tsx')) continue;
      yield full;
    }
  }
}

function ensureCapImport(text) {
  if (/from\s+['"]@\/lib\/capabilities['"]/.test(text)) {
    // Already imports something from capabilities; ensure CAP is in the
    // named-imports list. Most cases already have `{ CAP }`; if not,
    // surface it for manual review.
    if (/import\s*\{[^}]*\bCAP\b[^}]*\}\s*from\s+['"]@\/lib\/capabilities['"]/.test(text)) {
      return { text, addedImport: false };
    }
    // Add CAP into the existing import line.
    const updated = text.replace(
      /(import\s*\{)([^}]*)(\}\s*from\s+['"]@\/lib\/capabilities['"])/,
      (_match, p1, p2, p3) => `${p1}${p2.replace(/\s*$/, '')}, CAP${p3}`,
    );
    return { text: updated, addedImport: true };
  }
  // Insert a new import. Place it adjacent to the LAST `@/lib/*` import,
  // or after the last `import` line if no @/lib/ import exists.
  const lines = text.split('\n');
  let lastLibImportIdx = -1;
  let lastImportIdx = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (/^\s*import\s.+from\s+['"]@\/lib\/[^'"]+['"]/.test(line)) {
      lastLibImportIdx = i;
    }
    if (/^\s*import\s/.test(line)) {
      lastImportIdx = i;
    }
    // Stop once we leave the import block.
    if (lastImportIdx >= 0 && line.trim() !== '' && !/^\s*import\s/.test(line) && !line.trim().startsWith('//')) {
      // Heuristic: keep going through the import block; only break when
      // we hit a clearly post-import construct.
      if (/^(export|function|const|class|interface|type|let)\b/.test(line.trim())) {
        break;
      }
    }
  }
  const insertAt = lastLibImportIdx >= 0 ? lastLibImportIdx + 1 : lastImportIdx + 1;
  lines.splice(insertAt, 0, "import { CAP } from '@/lib/capabilities';");
  return { text: lines.join('\n'), addedImport: true };
}

function transform(text) {
  let updated = text;
  let touched = 0;
  const driftedKeys = new Set();

  // Replace capability="X" → capability={CAP.X_UPPER}
  updated = updated.replace(/capability="([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)"/g, (_match, key) => {
    const cap = CAP_KEYS.get(key);
    if (!cap) {
      driftedKeys.add(key);
      return _match;
    }
    touched += 1;
    return `capability={CAP.${cap}}`;
  });

  // Replace useCapability('X') → useCapability(CAP.X_UPPER)
  updated = updated.replace(/useCapability\(\s*'([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)'\s*\)/g, (_match, key) => {
    const cap = CAP_KEYS.get(key);
    if (!cap) {
      driftedKeys.add(key);
      return _match;
    }
    touched += 1;
    return `useCapability(CAP.${cap})`;
  });

  // Replace useCapability("X") (double-quoted) — same logic.
  updated = updated.replace(/useCapability\(\s*"([a-z][a-z0-9_]*\.[a-z][a-z0-9_.]*)"\s*\)/g, (_match, key) => {
    const cap = CAP_KEYS.get(key);
    if (!cap) {
      driftedKeys.add(key);
      return _match;
    }
    touched += 1;
    return `useCapability(CAP.${cap})`;
  });

  return { text: updated, touched, drifted: Array.from(driftedKeys) };
}

let totalTouched = 0;
let totalFiles = 0;
const allDrifted = new Set();

for (const file of walk(MODULES_DIR)) {
  const original = readFileSync(file, 'utf8');
  const { text: t1, touched, drifted } = transform(original);
  if (touched === 0 && drifted.length === 0) continue;
  let final = t1;
  if (touched > 0) {
    const { text: t2 } = ensureCapImport(t1);
    final = t2;
    totalTouched += touched;
    totalFiles += 1;
    if (writeMode) {
      writeFileSync(file, final, 'utf8');
    }
    console.log(`[codemod] ${touched.toString().padStart(3)} sub(s) in ${file.replace(APP_ROOT + '/', '')}`);
  }
  for (const k of drifted) allDrifted.add(`${k} (in ${file.replace(APP_ROOT + '/', '')})`);
}

console.log(`[codemod] ${writeMode ? 'applied' : 'would apply'}: ${totalTouched} substitutions across ${totalFiles} files`);
if (allDrifted.size > 0) {
  console.error(`[codemod] DRIFT: ${allDrifted.size} literal(s) reference keys not present in CAP:`);
  for (const k of allDrifted) console.error(`  - ${k}`);
  process.exit(1);
}
