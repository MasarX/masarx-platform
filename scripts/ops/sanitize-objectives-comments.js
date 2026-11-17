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

(function main() {
  const root = process.cwd();
  const dir = path.join(root, 'supabase', 'migrations');
  if (!fs.existsSync(dir)) { console.error('[sanitize-objectives] Not found:', dir); process.exit(1); }
  const files = walk(dir).filter(f => f.toLowerCase().endsWith('.sql'));
  let changes = 0;
  for (const f of files) {
    const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/);
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const idx = line.indexOf('-- objectives:');
      if (idx > -1) {
        const before = line.slice(0, idx);
        const comment = line.slice(idx + 3); // drop leading '-- '
        const replaced = `${before}/* ${comment} */`;
        if (replaced !== line) {
          lines[i] = replaced;
          modified = true;
        }
      }
    }
    if (modified) {
      fs.writeFileSync(f, lines.join('\n'), 'utf8');
      console.log('[sanitize-objectives] Fixed', path.relative(root, f));
      changes++;
    }
  }
  console.log(`[sanitize-objectives] Completed. Files changed=${changes}`);
})();

