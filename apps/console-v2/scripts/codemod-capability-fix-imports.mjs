#!/usr/bin/env node
// codemod-capability-fix-imports.mjs — repair the broken `import { CAP }`
// insertions made by codemod-capability-literals.mjs into the middle of
// multi-line import blocks. Detects the buggy pattern:
//
//   import {
//   import { CAP } from '@/lib/capabilities';
//     <body of multi-line import>
//   } from '...';
//
// and rewrites it to keep the multi-line import intact, hoisting the CAP
// import to a safe single-line position right after the multi-line block.

import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const APP_ROOT = resolve(__dirname, '..');
const MODULES_DIR = join(APP_ROOT, 'src', 'modules');

const writeMode = process.argv.includes('--write');
const PATTERN = /^import\s*\{\s*\nimport\s*\{\s*CAP\s*\}\s*from\s+['"]@\/lib\/capabilities['"];\s*\n/m;

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      yield* walk(full);
    } else if (st.isFile() && (full.endsWith('.tsx') || full.endsWith('.ts'))) {
      yield full;
    }
  }
}

let fixed = 0;
for (const file of walk(MODULES_DIR)) {
  const text = readFileSync(file, 'utf8');
  if (!PATTERN.test(text)) continue;
  // Strategy: remove the misplaced `import { CAP } from '@/lib/capabilities';`
  // line from inside the multi-line import, then append it as a standalone
  // import on its own line right after the multi-line block ends (the `}`
  // line of the broken import).
  const lines = text.split('\n');
  const out = [];
  let i = 0;
  let alreadyHasCapImport = false;
  // Pre-scan: does the file already have a clean `import { CAP } from '@/lib/capabilities';`
  // OUTSIDE the broken pattern? (The codemod may have left both — broken + clean.)
  // We treat the broken instance as removable; preserve any clean instance.
  for (const line of lines) {
    if (/^\s*import\s*\{\s*CAP\s*\}\s*from\s+['"]@\/lib\/capabilities['"];\s*$/.test(line)) {
      alreadyHasCapImport = true;
      break;
    }
  }
  while (i < lines.length) {
    const line = lines[i];
    // Detect the broken pattern: `import {` immediately followed by the CAP line.
    if (
      /^import\s*\{\s*$/.test(line) &&
      i + 1 < lines.length &&
      /^\s*import\s*\{\s*CAP\s*\}\s*from\s+['"]@\/lib\/capabilities['"];\s*$/.test(lines[i + 1])
    ) {
      // Keep the `import {` line, drop the next (CAP) line.
      out.push(line);
      i += 2;
      // Walk through the rest of the multi-line block until we hit `} from '...';`
      while (i < lines.length) {
        out.push(lines[i]);
        const closeMatch = /\}\s*from\s+['"][^'"]+['"];\s*$/.test(lines[i]);
        i += 1;
        if (closeMatch) break;
      }
      // After the closing line, insert the CAP import on its own line.
      if (!alreadyHasCapImport) {
        out.push("import { CAP } from '@/lib/capabilities';");
        alreadyHasCapImport = true;
      }
      continue;
    }
    out.push(line);
    i += 1;
  }
  const newText = out.join('\n');
  if (newText !== text) {
    fixed += 1;
    console.log(`[fix] ${file.replace(APP_ROOT + '/', '')}`);
    if (writeMode) writeFileSync(file, newText, 'utf8');
  }
}
console.log(`[fix] ${writeMode ? 'applied' : 'would apply'}: ${fixed} file(s)`);
