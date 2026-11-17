#!/usr/bin/env node
/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

// Fix pattern where a trailing block comment eats a closing parenthesis:
//   ... = 'value' /* objectives:... ) */
// should become:
//   ... = 'value' /* objectives:... */ )

const re = /(\/\*\s*objectives:[^*]*?)\)\s*\*\//gi;

(function main() {
  const root = process.cwd();
  const dir = path.join(root, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) { console.error('[sanitize-parens] Not found:', dir); process.exit(1); }
  const files = walk(dir).filter(f => f.toLowerCase().endsWith('.sql'));
  let changed = 0;
  for (const f of files) {
    const txt = fs.readFileSync(f, 'utf8');
    const fixed = txt.replace(re, (m, g1) => `${g1}*/ )`);
    if (fixed !== txt) {
      fs.writeFileSync(f, fixed, 'utf8');
      console.log('[sanitize-parens] Fixed', path.relative(root, f));
      changed++;
    }
  }
  console.log(`[sanitize-parens] Completed. Files changed=${changed}`);
})();

